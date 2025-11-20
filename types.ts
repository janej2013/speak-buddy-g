export interface Message {
  role: 'user' | 'model';
  text: string;
}

export interface DailyTopic {
  id: string;
  title: string;
  description: string;
  scenario: string;
  difficulty: string;
  openingLine: string;
}

export interface Feedback {
  isGood: boolean;
  correction?: string;
  advice?: string; // The "one bullet point"
  score?: number; // 1-5 stars
}

export enum AppMode {
  LANDING = 'LANDING',
  ONBOARDING = 'ONBOARDING', // Placement test
  DASHBOARD = 'DASHBOARD',
  PRACTICE = 'PRACTICE', // Daily task
  SUMMARY = 'SUMMARY'
}

export enum SpeakingState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  PROCESSING = 'PROCESSING',
  SPEAKING = 'SPEAKING' // App is talking
}

// Minimal SpeechRecognition type definition
export interface IWindow extends Window {
  SpeechRecognition: any;
  webkitSpeechRecognition: any;
}