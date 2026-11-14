//! WebAssembly bridge around the MPEG-1 Layer III encoder of the vendored
//! `audiobox` crate (see `vendor/audiobox-0.5.1/`, MIT, and `NOTICE.md`).
//!
//! The ABI is deliberately tiny and pointer-free from JavaScript's point of
//! view. Samples live in planar f32 buffers owned by Rust; JS asks for the
//! address of an input buffer, fills it, calls [`abx_encode`] and then copies
//! the encoded bytes out through [`abx_output_ptr`]/[`abx_output_len`].
//!
//! Every exported call may grow the WASM heap, which detaches every JS
//! `Float32Array`/`Uint8Array` view created earlier. Callers must re-create the
//! views after each call instead of caching them.
//!
//! Errors never unwind: [`abx_encode`] returns `0` and leaves a UTF-8 message
//! in the error buffer, so the worker can surface a readable reason.

use audiobox::{encode_with_options, Audio, AudioFormat, EncodeOptions};
use std::cell::RefCell;

/// Upper bound on the samples the bridge will allocate: two channels of f32 at
/// 48 kHz for six hours (~8 GiB) is far beyond what a browser tab can hold, so
/// this only guards against a bogus length turning into an instant OOM.
const MAX_SAMPLES: usize = 2 * 48_000 * 60 * 60 * 6;

#[derive(Default)]
struct State {
    /// Planar PCM: channel 0's frames, then channel 1's.
    input: Vec<f32>,
    output: Vec<u8>,
    error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State {
        input: Vec::new(),
        output: Vec::new(),
        error: Vec::new(),
    }) };
}

fn fail(state: &mut State, message: impl Into<String>) -> u32 {
    state.output.clear();
    state.error = message.into().into_bytes();
    0
}

/// Resize the input buffer to `samples` f32 values and return its address, or
/// `0` when the request is refused. The contents are unspecified until written.
#[no_mangle]
pub extern "C" fn abx_input(samples: usize) -> usize {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if samples == 0 || samples > MAX_SAMPLES {
            state.error = format!("Refusing to allocate {samples} samples").into_bytes();
            return 0;
        }
        state.error.clear();
        state.input.clear();
        state.input.resize(samples, 0.0);
        state.input.as_mut_ptr() as usize
    })
}

/// Encode the planar input buffer as an MP3 file.
///
/// `channels` must be 1 or 2 and `frames * channels` must match the buffer
/// filled through [`abx_input`]. `rate` is in Hz and `bitrate` in kbit/s.
/// Returns `1` on success and `0` on failure.
#[no_mangle]
pub extern "C" fn abx_encode(frames: usize, channels: usize, rate: u32, bitrate: u32) -> u32 {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if channels == 0 || channels > 2 {
            return fail(&mut state, format!("MP3 needs mono or stereo, not {channels} channels"));
        }
        let supplied = state.input.len();
        if frames == 0 || frames.checked_mul(channels) != Some(supplied) {
            return fail(
                &mut state,
                format!(
                    "{frames} frames of {channels} channels do not match the {supplied} samples supplied"
                ),
            );
        }

        // Copy each plane into its own Vec: `Audio` owns its channel data and
        // the encoder reads it channel by channel.
        let mut planes = Vec::with_capacity(channels);
        for channel in 0..channels {
            planes.push(state.input[channel * frames..(channel + 1) * frames].to_vec());
        }

        let audio = match Audio::new(planes, rate) {
            Ok(audio) => audio,
            Err(error) => return fail(&mut state, error.to_string()),
        };
        let options = EncodeOptions {
            bitrate,
            ..EncodeOptions::default()
        };
        match encode_with_options(&audio, AudioFormat::Mp3, &options) {
            Ok(bytes) if bytes.is_empty() => fail(&mut state, "The MP3 encoder produced no bytes"),
            Ok(bytes) => {
                state.output = bytes;
                state.error.clear();
                1
            }
            Err(error) => fail(&mut state, error.to_string()),
        }
    })
}

/// Address of the encoded bytes. Valid until the next exported call.
#[no_mangle]
pub extern "C" fn abx_output_ptr() -> usize {
    STATE.with(|cell| cell.borrow().output.as_ptr() as usize)
}

/// Length of the encoded bytes, in bytes. `0` until [`abx_encode`] succeeds.
#[no_mangle]
pub extern "C" fn abx_output_len() -> usize {
    STATE.with(|cell| cell.borrow().output.len())
}

/// Address of the last error message (UTF-8). Empty when the last call worked.
#[no_mangle]
pub extern "C" fn abx_error_ptr() -> usize {
    STATE.with(|cell| cell.borrow().error.as_ptr() as usize)
}

/// Length of the last error message, in bytes.
#[no_mangle]
pub extern "C" fn abx_error_len() -> usize {
    STATE.with(|cell| cell.borrow().error.len())
}
