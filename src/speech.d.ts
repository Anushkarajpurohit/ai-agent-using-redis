// Minimal ambient declarations so TypeScript doesn't complain about the
// Web Speech API, which isn't part of the standard DOM lib typings yet.
// Only the bits ChatVoiceUI.tsx actually uses are declared.

interface Window {
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
}
