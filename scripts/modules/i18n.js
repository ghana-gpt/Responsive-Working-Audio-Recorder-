/**
 * Internationalisation.
 *
 * Keeping this as a pure module means tests can assert that every key exists in
 * every locale (see tests/unit/i18n.test.js) — the original single-language
 * page had hard-coded English strings scattered through the markup and JS.
 */

export const DEFAULT_LOCALE = 'en';

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];

/** @type {Record<string, Record<string, string>>} */
export const messages = {
  en: {
    'app.title': 'Audio Recorder',
    'app.tagline':
      'Record, review and download audio — private by default, everything stays in your browser.',
    'app.skipToContent': 'Skip to main content',

    'nav.language': 'Language',
    'nav.theme': 'Theme',
    'nav.themeSystem': 'Match system',
    'nav.themeLight': 'Light',
    'nav.themeDark': 'Dark',
    'nav.help': 'Help',
    'nav.localeAuto': 'Automatic (browser language)',

    'status.idle': 'Ready when you are. Press record to start.',
    'status.requesting': 'Waiting for microphone permission…',
    'status.recording': 'Recording…',
    'status.paused': 'Paused.',
    'status.processing': 'Processing audio…',
    'status.ready': 'Recording saved. Play it back, rename it, or download it.',
    'status.error': 'Something went wrong.',
    'status.offline': 'Offline — the app still works and your recordings are stored locally.',

    'controls.groupLabel': 'Recorder controls',
    'controls.record': 'Start recording',
    'controls.pause': 'Pause recording',
    'controls.resume': 'Resume recording',
    'controls.stop': 'Stop recording',
    'controls.timer': 'Elapsed recording time',
    'controls.meter': 'Input level',

    'library.title': 'Your recordings',
    'library.count': '{count} saved',
    'library.empty':
      'Nothing recorded yet. Your recordings will appear here and stay on this device.',
    'library.search': 'Search recordings',
    'library.searchPlaceholder': 'Search by name or tag',
    'library.sort': 'Sort by',
    'library.sortNewest': 'Newest first',
    'library.sortOldest': 'Oldest first',
    'library.sortName': 'Name (A–Z)',
    'library.sortLongest': 'Longest first',
    'library.sortLargest': 'Largest first',
    'library.showMore': 'Show {count} more',
    'library.showingCount': 'Showing {shown} of {total}',
    'library.downloadAll': 'Download all as ZIP',
    'library.clearAll': 'Delete all',
    'library.noMatches': 'No recordings match “{query}”.',
    'library.toolbar': 'Library tools',
    'library.select': 'Select “{name}”',
    'library.selectAll': 'Select every recording',
    'library.selectedCount': '{count} selected',
    'library.downloadSelected': 'Download selected as ZIP',
    'library.deleteSelected': 'Delete selected',
    'library.import': 'Import audio files',
    'library.importHint': 'MP3, WAV, OGG, M4A, WebM — or a ZIP backup from this app',

    'recording.untitled': 'Untitled recording',
    'recording.nameLabel': 'Recording name',
    'recording.tagsLabel': 'Tags',
    'recording.tagsPlaceholder': 'e.g. meeting, idea',
    'recording.play': 'Play “{name}”',
    'recording.pause': 'Pause “{name}”',
    'recording.download': 'Download “{name}”',
    'recording.share': 'Share “{name}”',
    'recording.trim': 'Trim “{name}”',
    'recording.delete': 'Delete “{name}”',
    'recording.rename': 'Rename “{name}”',
    'recording.renameSave': 'Save name and tags',
    'recording.meta': '{format} · {size} · {duration}',
    'recording.created': 'Recorded {date}',
    'recording.preview': 'Audio preview for “{name}”',
    'recording.trimmed': 'Trimmed',
    'recording.actions': 'Actions for “{name}”',
    'recording.openActions': 'More actions',

    'actions.save': 'Save',
    'actions.cancel': 'Cancel',
    'actions.close': 'Close',
    'actions.delete': 'Delete',
    'actions.apply': 'Apply',
    'actions.retry': 'Try again',
    'actions.rename': 'Rename',
    'actions.reset': 'Reset',
    'actions.download': 'Download',
    'actions.ok': 'OK',

    'dialog.trimTitle': 'Trim recording',
    'dialog.trimDescription':
      'Drag the handles to keep only part of “{name}”. The trimmed copy is saved as a new WAV recording; the original is kept.',
    'dialog.trimStart': 'Start',
    'dialog.trimEnd': 'End',
    'dialog.trimApply': 'Save trimmed copy',
    'dialog.trimInvalid': 'The end time must be after the start time.',
    'dialog.trimNote':
      'Trimming exports 16-bit PCM WAV, so the copy may be larger than the original.',
    'dialog.deleteTitle': 'Delete recording?',
    'dialog.deleteBody':
      '“{name}” will be permanently removed from this device. This cannot be undone.',
    'dialog.deleteAllTitle': 'Delete all recordings?',
    'dialog.deleteAllBody':
      'All {count} recordings will be permanently removed from this device. This cannot be undone.',
    'dialog.deleteSelectedTitle': 'Delete the selected recordings?',
    'dialog.deleteSelectedBody':
      '{count} recordings will be permanently removed from this device. This cannot be undone.',
    'dialog.largeExportTitle': 'Build a large archive?',
    'dialog.largeExportBody':
      'This download is about {size}. The browser keeps the audio on this device until the save finishes, and it may take a while.',

    'settings.title': 'Preferences',
    'settings.format': 'Recording format',
    'settings.formatAuto': 'Automatic (best available)',
    'settings.formatWebm': 'WebM / Opus',
    'settings.formatOgg': 'OGG / Opus',
    'settings.formatMp4': 'MP4 / AAC (M4A)',
    'settings.formatWav': 'WAV (PCM 16-bit)',
    'settings.formatMp3': 'MP3',
    'settings.formatHint': 'Only formats your browser can produce are enabled.',
    'settings.formatUnavailable': 'not supported by this browser',
    'settings.formatNeedsEncoder': 'no browser records MP3 directly',
    'settings.formatMp3Local': 'encoded locally when native MP3 recording is unavailable',
    'settings.quality': 'Audio quality',
    'settings.qualityHint': 'Bitrate for compressed formats. WAV always uses 16-bit PCM.',
    'settings.quality32': '32 kbps (speech)',
    'settings.quality64': '64 kbps (voice notes)',
    'settings.quality96': '96 kbps (balanced)',
    'settings.quality128': '128 kbps (high)',
    'settings.quality256': '256 kbps (maximum)',
    'settings.processing': 'Microphone processing',
    'settings.processingHint': 'Applied by the browser/OS when available. Turn off for raw audio.',
    'settings.noiseSuppression': 'Noise suppression',
    'settings.echoCancellation': 'Echo cancellation',
    'settings.autoGainControl': 'Automatic gain control',
    'settings.creditTitle': 'Sponsor credit',
    'settings.credit': 'Show sponsor credit in the footer',
    'settings.creditHint': 'A single static link. No scripts, no tracking, always removable.',
    'settings.stats': 'Local statistics',
    'settings.statsRecordings': 'Recordings: {count}',
    'settings.statsDuration': 'Total duration: {duration}',
    'settings.statsStorage': 'Approximate size: {size}',
    'settings.shortcuts': 'Keyboard shortcuts',
    'settings.reset': 'Reset preferences',
    'settings.languageHint': 'Interface language. “Automatic” follows your browser.',
    'settings.storageProtected':
      'Storage is protected: this browser agreed to keep your recordings.',
    'settings.storageBestEffort':
      'Storage is best-effort: the browser may clear recordings when space runs low. Export important audio.',
    'settings.storageUsage': 'Space used',
    'settings.storageUsageValue': '{used} of {quota} ({percent}%)',
    'settings.storageUnknown': 'This browser does not report storage usage.',
    'settings.storageLow':
      'Storage is almost full. Export a backup and delete recordings you no longer need.',
    'settings.storageCritical':
      'Storage is full. New recordings may fail until you free some space.',
    'settings.storageTop': 'Largest recordings',
    'settings.storageTopEmpty': 'No recordings stored yet.',
    'settings.themeHint': '“Match system” follows your operating system setting.',

    'shortcut.record': 'R or Space — start / stop recording',
    'shortcut.pause': 'P — pause or resume',
    'shortcut.play': 'Enter — play the selected recording',
    'shortcut.delete': 'Delete — delete the selected recording',
    'shortcut.help': '? — open this help panel',
    'shortcut.note': 'Shortcuts are ignored while you type in a text field.',

    'help.title': 'How to use the recorder',
    'help.step1': 'Press the record button and allow microphone access.',
    'help.step2': 'Pause and resume whenever you like — the timer only counts while recording.',
    'help.step3': 'Press stop to save. The audio is stored on this device in IndexedDB.',
    'help.step4': 'Rename, tag, trim, play back or download — individually or as a ZIP.',
    'help.privacy':
      'Audio never leaves your device. No server, no account, no analytics, no cookies.',

    'errors.micDenied':
      'Microphone permission was denied. Allow access in your browser settings and try again.',
    'errors.micNotFound': 'No microphone was found. Connect one and try again.',
    'errors.micInUse': 'The microphone is busy in another application.',
    'errors.insecureContext': 'Microphone access needs HTTPS or localhost.',
    'errors.unsupportedBrowser': 'This browser cannot record audio (MediaRecorder is missing).',
    'errors.recordFailed': 'Recording failed: {message}',
    'errors.saveFailed': 'Could not save the recording: {message}',
    'errors.storageUnavailable': 'Local storage is unavailable, so recordings cannot be saved.',
    'errors.quotaExceeded': 'Not enough local storage left. Delete older recordings and try again.',
    'errors.conversionFailed': 'Could not convert the audio.',
    'errors.decodeFailed': 'Could not decode this recording for trimming.',
    'errors.shareUnavailable': 'Sharing files is not supported here. Use download instead.',
    'errors.zipFailed': 'Could not build the ZIP archive.',
    'errors.archiveUnreadable': 'That ZIP archive could not be read: {message}',
    'errors.archiveEmpty': 'That archive does not contain any audio files this app can read.',
    'errors.invalidFormat': 'That format is not available in this browser.',
    'errors.noStream': 'The microphone stream is no longer available.',
    'errors.unknown': 'Unexpected error: {message}',
    'errors.title': 'Microphone problem',
    'errors.notFound': 'That recording is no longer available.',
    'errors.micBlocked':
      'Microphone access is blocked for this site. Open your browser’s site settings, allow the microphone, then reload.',
    'errors.importFailed': 'Could not import “{name}”: {message}',
    'errors.unsupportedFile': '“{name}” is not an audio file this browser can decode.',
    'errors.trimFailed': 'Could not trim the recording: {message}',
    'errors.conversionBusy':
      'Another conversion is already running. Wait for it to finish, then try again.',

    'toast.saved': 'Saved “{name}”.',
    'toast.deleted': 'Deleted “{name}”.',
    'toast.deletedAll': 'Deleted {count} recordings.',
    'toast.updated': 'Recording updated.',
    'toast.downloaded': 'Download started.',
    'toast.zipped': 'ZIP with {count} recordings downloaded.',
    'toast.restored': 'Restored {count} recording(s) from the archive.',
    'toast.restoreSkipped': 'Skipped {count} file(s) that failed the integrity check.',
    'toast.shared': 'Shared “{name}”.',
    'toast.trimmed': 'Trimmed copy saved as “{name}”.',
    'toast.conversionCancelled': 'Conversion cancelled — nothing was saved.',
    'toast.languageChanged': 'Language set to English.',
    'toast.statsCleared': 'Statistics cleared.',
    'toast.noRecordings': 'There are no recordings to export yet.',
    'toast.renamed': 'Renamed to “{name}”.',
    'toast.preferencesReset': 'Preferences reset.',
    'toast.imported': 'Imported {count} file(s).',
    'toast.storageProtected': 'Storage is now protected from automatic cleanup.',
    'toast.quotaLow': 'Storage is {percent}% full — export a backup or delete old recordings.',
    'toast.quotaCritical':
      'Storage is {percent}% full — new recordings may fail. Export and free space now.',

    'conversion.heading': 'Audio conversion',
    'conversion.convertingWav': 'Converting to WAV…',
    'conversion.convertingMp3': 'Encoding to MP3…',
    'conversion.trimmingWav': 'Trimming audio…',

    'misc.offlineReady': 'Ready for offline use.',
    'misc.updateReady': 'A new version is available.',
    'misc.reload': 'Reload',
    'misc.install': 'Install app',
    'misc.micReady': 'Microphone ready.',
    'misc.recording': 'Recording',
    'misc.unknown': 'Unknown',
    'misc.mono': 'mono',
    'misc.stereo': 'stereo',
    'misc.formatHint': 'Will record as {format}',

    'footer.rights': '© {year} Audio Recorder — released under the MIT licence.',
    'footer.license': 'MIT licence',
    'footer.encoderLicense': 'MP3 encoder: lamejs 1.2.1 (LGPL-3.0)',
    'footer.source': 'Source code',
    'footer.linksLabel': 'Project links',
    'footer.credit': 'Sponsored by Ghana-GPT.com',
    'footer.creditLabel': 'Sponsor:',
  },

  fr: {
    'app.title': 'Enregistreur audio',
    'app.tagline':
      'Enregistrez, écoutez et téléchargez de l’audio — privé par défaut, tout reste dans votre navigateur.',
    'app.skipToContent': 'Aller au contenu principal',

    'nav.language': 'Langue',
    'nav.theme': 'Thème',
    'nav.themeSystem': 'Comme le système',
    'nav.themeLight': 'Clair',
    'nav.themeDark': 'Sombre',
    'nav.help': 'Aide',
    'nav.localeAuto': 'Automatique (langue du navigateur)',

    'status.idle': 'Prêt. Appuyez sur enregistrer pour commencer.',
    'status.requesting': 'Autorisation du microphone en attente…',
    'status.recording': 'Enregistrement…',
    'status.paused': 'En pause.',
    'status.processing': 'Traitement de l’audio…',
    'status.ready': 'Enregistrement sauvegardé. Écoutez-le, renommez-le ou téléchargez-le.',
    'status.error': 'Une erreur est survenue.',
    'status.offline':
      'Hors ligne — l’application fonctionne et vos enregistrements restent stockés localement.',

    'controls.groupLabel': 'Commandes d’enregistrement',
    'controls.record': 'Démarrer l’enregistrement',
    'controls.pause': 'Mettre en pause',
    'controls.resume': 'Reprendre l’enregistrement',
    'controls.stop': 'Arrêter l’enregistrement',
    'controls.timer': 'Durée écoulée',
    'controls.meter': 'Niveau d’entrée',

    'library.title': 'Vos enregistrements',
    'library.count': '{count} enregistré(s)',
    'library.empty':
      'Aucun enregistrement. Vos enregistrements apparaîtront ici et resteront sur cet appareil.',
    'library.search': 'Rechercher des enregistrements',
    'library.searchPlaceholder': 'Rechercher par nom ou étiquette',
    'library.sort': 'Trier par',
    'library.sortNewest': 'Plus récents d’abord',
    'library.sortOldest': 'Plus anciens d’abord',
    'library.sortName': 'Nom (A–Z)',
    'library.sortLongest': 'Plus longs d’abord',
    'library.sortLargest': 'Plus volumineux d’abord',
    'library.showMore': 'Afficher {count} de plus',
    'library.showingCount': '{shown} sur {total} affichés',
    'library.downloadAll': 'Tout télécharger en ZIP',
    'library.clearAll': 'Tout supprimer',
    'library.noMatches': 'Aucun enregistrement ne correspond à « {query} ».',
    'library.toolbar': 'Outils de la bibliothèque',
    'library.select': 'Sélectionner « {name} »',
    'library.selectAll': 'Sélectionner tous les enregistrements',
    'library.selectedCount': '{count} sélectionné(s)',
    'library.downloadSelected': 'Télécharger la sélection en ZIP',
    'library.deleteSelected': 'Supprimer la sélection',
    'library.import': 'Importer des fichiers audio',
    'library.importHint': 'MP3, WAV, OGG, M4A, WebM — ou une sauvegarde ZIP de cette application',

    'recording.untitled': 'Enregistrement sans titre',
    'recording.nameLabel': 'Nom de l’enregistrement',
    'recording.tagsLabel': 'Étiquettes',
    'recording.tagsPlaceholder': 'ex. réunion, idée',
    'recording.play': 'Lire « {name} »',
    'recording.pause': 'Mettre « {name} » en pause',
    'recording.download': 'Télécharger « {name} »',
    'recording.share': 'Partager « {name} »',
    'recording.trim': 'Découper « {name} »',
    'recording.delete': 'Supprimer « {name} »',
    'recording.rename': 'Renommer « {name} »',
    'recording.renameSave': 'Enregistrer le nom et les étiquettes',
    'recording.meta': '{format} · {size} · {duration}',
    'recording.created': 'Enregistré le {date}',
    'recording.preview': 'Aperçu audio de « {name} »',
    'recording.trimmed': 'Découpé',
    'recording.actions': 'Actions pour « {name} »',
    'recording.openActions': 'Plus d’actions',

    'actions.save': 'Enregistrer',
    'actions.cancel': 'Annuler',
    'actions.close': 'Fermer',
    'actions.delete': 'Supprimer',
    'actions.apply': 'Appliquer',
    'actions.retry': 'Réessayer',
    'actions.rename': 'Renommer',
    'actions.reset': 'Réinitialiser',
    'actions.download': 'Télécharger',
    'actions.ok': 'OK',

    'dialog.trimTitle': 'Découper l’enregistrement',
    'dialog.trimDescription':
      'Faites glisser les poignées pour ne garder qu’une partie de « {name} ». La copie découpée est enregistrée comme un nouveau fichier WAV ; l’original est conservé.',
    'dialog.trimStart': 'Début',
    'dialog.trimEnd': 'Fin',
    'dialog.trimApply': 'Enregistrer la copie',
    'dialog.trimInvalid': 'La fin doit être postérieure au début.',
    'dialog.trimNote':
      'Le découpage exporte du WAV PCM 16 bits : la copie peut être plus volumineuse que l’original.',
    'dialog.deleteTitle': 'Supprimer l’enregistrement ?',
    'dialog.deleteBody':
      '« {name} » sera définitivement supprimé de cet appareil. Cette action est irréversible.',
    'dialog.deleteAllTitle': 'Supprimer tous les enregistrements ?',
    'dialog.deleteAllBody':
      'Les {count} enregistrements seront définitivement supprimés de cet appareil. Cette action est irréversible.',
    'dialog.deleteSelectedTitle': 'Supprimer les enregistrements sélectionnés ?',
    'dialog.deleteSelectedBody':
      'Les {count} enregistrements seront définitivement supprimés de cet appareil. Cette action est irréversible.',
    'dialog.largeExportTitle': 'Créer une archive volumineuse ?',
    'dialog.largeExportBody':
      'Ce téléchargement fait environ {size}. Le navigateur conserve l’audio sur cet appareil jusqu’à la fin de l’enregistrement, ce qui peut prendre du temps.',

    'settings.title': 'Préférences',
    'settings.format': 'Format d’enregistrement',
    'settings.formatAuto': 'Automatique (meilleur disponible)',
    'settings.formatWebm': 'WebM / Opus',
    'settings.formatOgg': 'OGG / Opus',
    'settings.formatMp4': 'MP4 / AAC (M4A)',
    'settings.formatWav': 'WAV (PCM 16 bits)',
    'settings.formatMp3': 'MP3',
    'settings.formatHint': 'Seuls les formats pris en charge par votre navigateur sont activés.',
    'settings.formatUnavailable': 'non pris en charge par ce navigateur',
    'settings.formatNeedsEncoder': 'aucun navigateur n’enregistre directement en MP3',
    'settings.formatMp3Local': 'encodé localement si le navigateur ne peut pas enregistrer en MP3',
    'settings.quality': 'Qualité audio',
    'settings.qualityHint':
      'Débit pour les formats compressés. Le WAV utilise toujours du PCM 16 bits.',
    'settings.quality32': '32 kbit/s (parole)',
    'settings.quality64': '64 kbit/s (notes vocales)',
    'settings.quality96': '96 kbit/s (équilibré)',
    'settings.quality128': '128 kbit/s (élevé)',
    'settings.quality256': '256 kbit/s (maximum)',
    'settings.processing': 'Traitement du microphone',
    'settings.processingHint':
      'Appliqué par le navigateur ou le système si disponible. Désactivez pour un son brut.',
    'settings.noiseSuppression': 'Réduction du bruit',
    'settings.echoCancellation': 'Annulation d’écho',
    'settings.autoGainControl': 'Gain automatique',
    'settings.creditTitle': 'Crédit du sponsor',
    'settings.credit': 'Afficher le crédit du sponsor dans le pied de page',
    'settings.creditHint':
      'Un simple lien statique. Aucun script, aucun suivi, toujours désactivable.',
    'settings.stats': 'Statistiques locales',
    'settings.statsRecordings': 'Enregistrements : {count}',
    'settings.statsDuration': 'Durée totale : {duration}',
    'settings.statsStorage': 'Taille approximative : {size}',
    'settings.shortcuts': 'Raccourcis clavier',
    'settings.reset': 'Réinitialiser les préférences',
    'settings.languageHint':
      'Langue de l’interface. « Automatique » suit la langue de votre navigateur.',
    'settings.storageProtected':
      'Stockage protégé : ce navigateur a accepté de conserver vos enregistrements.',
    'settings.storageBestEffort':
      'Stockage au mieux : le navigateur peut effacer des enregistrements si l’espace manque. Exportez les audios importants.',
    'settings.storageUsage': 'Espace utilisé',
    'settings.storageUsageValue': '{used} sur {quota} ({percent} %)',
    'settings.storageUnknown': 'Ce navigateur ne communique pas l’espace utilisé.',
    'settings.storageLow':
      'Le stockage est presque plein. Exportez une sauvegarde et supprimez les enregistrements inutiles.',
    'settings.storageCritical':
      'Le stockage est plein. Les nouveaux enregistrements risquent d’échouer tant que de l’espace n’est pas libéré.',
    'settings.storageTop': 'Enregistrements les plus volumineux',
    'settings.storageTopEmpty': 'Aucun enregistrement stocké pour le moment.',
    'settings.themeHint': '« Comme le système » suit le réglage de votre système.',

    'shortcut.record': 'R ou Espace — démarrer / arrêter',
    'shortcut.pause': 'P — pause ou reprise',
    'shortcut.play': 'Entrée — lire l’enregistrement sélectionné',
    'shortcut.delete': 'Suppr — supprimer l’enregistrement sélectionné',
    'shortcut.help': '? — ouvrir ce panneau d’aide',
    'shortcut.note': 'Les raccourcis sont ignorés lorsque vous saisissez du texte.',

    'help.title': 'Comment utiliser l’enregistreur',
    'help.step1': 'Appuyez sur le bouton d’enregistrement et autorisez le microphone.',
    'help.step2':
      'Mettez en pause et reprenez quand vous voulez — le chronomètre ne compte qu’en enregistrement.',
    'help.step3':
      'Appuyez sur arrêter pour sauvegarder. L’audio est stocké sur cet appareil dans IndexedDB.',
    'help.step4': 'Renommez, étiquetez, découpez, écoutez ou téléchargez — à l’unité ou en ZIP.',
    'help.privacy':
      'L’audio ne quitte jamais votre appareil. Aucun serveur, aucun compte, aucun suivi.',

    'errors.micDenied':
      'L’autorisation du microphone a été refusée. Autorisez l’accès dans les réglages du navigateur puis réessayez.',
    'errors.micNotFound': 'Aucun microphone détecté. Branchez-en un puis réessayez.',
    'errors.micInUse': 'Le microphone est utilisé par une autre application.',
    'errors.insecureContext': 'Le microphone nécessite HTTPS ou localhost.',
    'errors.unsupportedBrowser':
      'Ce navigateur ne peut pas enregistrer d’audio (MediaRecorder absent).',
    'errors.recordFailed': 'Échec de l’enregistrement : {message}',
    'errors.saveFailed': 'Impossible de sauvegarder l’enregistrement : {message}',
    'errors.storageUnavailable':
      'Le stockage local est indisponible : les enregistrements ne peuvent pas être sauvegardés.',
    'errors.quotaExceeded':
      'Espace de stockage local insuffisant. Supprimez d’anciens enregistrements puis réessayez.',
    'errors.conversionFailed': 'Impossible de convertir l’audio.',
    'errors.decodeFailed': 'Impossible de décoder cet enregistrement pour le découpage.',
    'errors.shareUnavailable':
      'Le partage de fichiers n’est pas disponible ici. Utilisez le téléchargement.',
    'errors.zipFailed': 'Impossible de créer l’archive ZIP.',
    'errors.archiveUnreadable': 'Impossible de lire cette archive ZIP : {message}',
    'errors.archiveEmpty':
      'Cette archive ne contient aucun fichier audio lisible par cette application.',
    'errors.invalidFormat': 'Ce format n’est pas disponible dans ce navigateur.',
    'errors.noStream': 'Le flux du microphone n’est plus disponible.',
    'errors.unknown': 'Erreur inattendue : {message}',
    'errors.title': 'Problème de microphone',
    'errors.notFound': 'Cet enregistrement n’est plus disponible.',
    'errors.micBlocked':
      'L’accès au microphone est bloqué pour ce site. Ouvrez les réglages du site dans votre navigateur, autorisez le microphone puis rechargez.',
    'errors.importFailed': 'Impossible d’importer « {name} » : {message}',
    'errors.unsupportedFile':
      '« {name} » n’est pas un fichier audio que ce navigateur peut décoder.',
    'errors.trimFailed': 'Impossible de découper l’enregistrement : {message}',
    'errors.conversionBusy':
      'Une autre conversion est déjà en cours. Attendez qu’elle se termine, puis réessayez.',

    'toast.saved': '« {name} » enregistré.',
    'toast.deleted': '« {name} » supprimé.',
    'toast.deletedAll': '{count} enregistrements supprimés.',
    'toast.updated': 'Enregistrement mis à jour.',
    'toast.downloaded': 'Téléchargement lancé.',
    'toast.zipped': 'ZIP de {count} enregistrements téléchargé.',
    'toast.restored': '{count} enregistrement(s) restauré(s) depuis l’archive.',
    'toast.restoreSkipped': '{count} fichier(s) ignoré(s) : le contrôle d’intégrité a échoué.',
    'toast.shared': '« {name} » partagé.',
    'toast.trimmed': 'Copie découpée enregistrée sous « {name} ».',
    'toast.conversionCancelled': 'Conversion annulée — rien n’a été enregistré.',
    'toast.languageChanged': 'Langue définie sur le français.',
    'toast.statsCleared': 'Statistiques effacées.',
    'toast.noRecordings': 'Aucun enregistrement à exporter pour le moment.',
    'toast.renamed': 'Renommé en « {name} ».',
    'toast.preferencesReset': 'Préférences réinitialisées.',
    'toast.imported': '{count} fichier(s) importé(s).',
    'toast.storageProtected': 'Le stockage est désormais protégé du nettoyage automatique.',
    'toast.quotaLow':
      'Le stockage est plein à {percent} % — exportez une sauvegarde ou supprimez d’anciens enregistrements.',
    'toast.quotaCritical':
      'Le stockage est plein à {percent} % — les nouveaux enregistrements risquent d’échouer. Exportez et libérez de l’espace.',

    'conversion.heading': 'Conversion audio',
    'conversion.convertingWav': 'Conversion en WAV…',
    'conversion.convertingMp3': 'Encodage en MP3…',
    'conversion.trimmingWav': 'Découpage de l’audio…',

    'misc.offlineReady': 'Prêt pour une utilisation hors ligne.',
    'misc.updateReady': 'Une nouvelle version est disponible.',
    'misc.reload': 'Recharger',
    'misc.install': 'Installer l’application',
    'misc.micReady': 'Microphone prêt.',
    'misc.recording': 'Enregistrement',
    'misc.unknown': 'Inconnu',
    'misc.mono': 'mono',
    'misc.stereo': 'stéréo',
    'misc.formatHint': 'Enregistrement en {format}',

    'footer.rights': '© {year} Enregistreur audio — publié sous licence MIT.',
    'footer.license': 'Licence MIT',
    'footer.encoderLicense': 'Encodeur MP3 : lamejs 1.2.1 (LGPL-3.0)',
    'footer.source': 'Code source',
    'footer.linksLabel': 'Liens du projet',
    'footer.credit': 'Sponsorisé par Ghana-GPT.com',
    'footer.creditLabel': 'Sponsor :',
  },
};

/**
 * Look up a key in one locale, falling back to the default locale and finally
 * to the key itself so the UI never renders "undefined".
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @param {string} [locale]
 * @returns {string}
 */
export function t(key, params = {}, locale = DEFAULT_LOCALE) {
  const dictionary = messages[locale] ?? messages[DEFAULT_LOCALE];
  const template = dictionary[key] ?? messages[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Bind a locale once: returns a `t(key, params)` function.
 * @param {string} locale
 * @returns {(key: string, params?: Record<string, string|number>) => string}
 */
export function createTranslator(locale = DEFAULT_LOCALE) {
  return (key, params) => t(key, params, locale);
}

/**
 * Codes that deliberately share a message with another code.
 * `storage-failed` and `connection-closed` are both "local storage is not
 * usable" from the user's point of view.
 */
const ERROR_CODE_ALIASES = Object.freeze({
  'storage-failed': 'storageUnavailable',
  'connection-closed': 'storageUnavailable',
  'already-running': 'recordFailed',
});

/**
 * Message key for an error code.
 *
 * Recorder errors use camelCase codes (`micDenied`) while storage errors use
 * kebab-case ones (`quota-exceeded`); both spellings resolve to the same
 * catalogue entries so a quota failure never falls back to "Unexpected error".
 *
 * @param {string} code
 * @returns {string} an `errors.*` key (may not exist for unknown codes)
 */
export function errorKeyForCode(code) {
  const raw = String(code ?? '').trim() || 'unknown';
  const aliased = ERROR_CODE_ALIASES[raw];
  if (aliased) return `errors.${aliased}`;
  const camel = raw.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return `errors.${camel}`;
}

/**
 * Keys present in the default locale but missing in `locale` (and vice versa).
 * Used by the unit tests to keep translations in sync.
 *
 * @param {string} locale
 * @returns {{ missing: string[], extra: string[] }}
 */
export function diffKeys(locale) {
  const base = Object.keys(messages[DEFAULT_LOCALE]);
  const target = Object.keys(messages[locale] ?? {});
  return {
    missing: base.filter((key) => !target.includes(key)),
    extra: target.filter((key) => !base.includes(key)),
  };
}

/**
 * Pick the first supported locale from a list of candidates (e.g. the
 * persisted preference first, then navigator.languages).
 *
 * @param {Iterable<string>} candidates
 * @returns {string}
 */
export function resolveLocale(candidates) {
  const supported = SUPPORTED_LOCALES.map((entry) => entry.code);
  for (const candidate of candidates ?? []) {
    if (!candidate) continue;
    const normalised = String(candidate).trim().toLowerCase();
    const exact = supported.find((code) => code === normalised);
    if (exact) return exact;
    const partial = supported.find((code) => normalised.startsWith(`${code}-`));
    if (partial) return partial;
  }
  return DEFAULT_LOCALE;
}
