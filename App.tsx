import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Volume2, Play, Star, CheckCircle, RefreshCcw, XCircle, Loader2, HelpCircle, Send, RotateCcw, BookOpen, Bug, GraduationCap, ArrowLeft, Settings, Sparkles } from 'lucide-react';
import { AppMode, SpeakingState, Message, DailyTopic, Feedback, IWindow } from './types';
import * as GeminiService from './services/gemini';

// --- Constants ---

const CEFR_DESCRIPTIONS: Record<string, string> = {
  'A1': "Beginner: Simple phrases for basic needs.",
  'A2': "Elementary: Simple, routine tasks.",
  'B1': "Intermediate: Travel & describing experiences.",
  'B2': "Upper Intermediate: Fluent interaction.",
  'C1': "Advanced: Flexible, structured expression.",
  'C2': "Mastery: Effortless understanding."
};

// --- Helper Components ---

const Avatar = ({ speaking, imageUrl }: { speaking: boolean; imageUrl: string }) => (
  <div className="relative flex items-center justify-center mb-6 transition-all duration-500">
    <div className={`w-32 h-32 md:w-48 md:h-48 rounded-full overflow-hidden border-4 border-white shadow-2xl transition-transform duration-300 ${speaking ? 'talking scale-105 shadow-blue-500/50' : ''}`}>
      <img src={imageUrl} alt="AI Partner" className="w-full h-full object-cover" />
    </div>
    {speaking && (
      <div className="absolute -bottom-2 bg-blue-500 text-white px-3 py-1 rounded-full text-xs font-bold animate-bounce shadow-lg">
        SPEAKING...
      </div>
    )}
  </div>
);

const Waveform = ({ active }: { active: boolean }) => (
  <div className={`flex justify-center items-end h-8 space-x-1 ${active ? 'opacity-100' : 'opacity-20'}`}>
    {[1, 2, 3, 4, 5].map((i) => (
      <div key={i} className={`w-2 bg-green-400 rounded-t-md ${active ? 'wave-bar' : 'h-2'}`}></div>
    ))}
  </div>
);

const ProgressBar = ({ current, total, label }: { current: number; total: number; label?: string }) => (
  <div className="w-full max-w-xs mb-4 flex flex-col gap-1">
    {label && <div className="text-xs text-gray-400 font-semibold uppercase tracking-wider text-center">{label}</div>}
    <div className="bg-gray-700 rounded-full h-2.5 w-full">
      <div 
        className="bg-blue-500 h-2.5 rounded-full transition-all duration-500" 
        style={{ width: `${Math.min((current / total) * 100, 100)}%` }}
      ></div>
    </div>
    <div className="text-right text-xs text-gray-500">{current} / {total}</div>
  </div>
);

// --- Main App ---

export default function App() {
  // State
  const [mode, setMode] = useState<AppMode>(AppMode.LANDING);
  const [userLevel, setUserLevel] = useState<string>('A2');
  const [showLevelSelector, setShowLevelSelector] = useState(false);
  
  const [speakingState, setSpeakingState] = useState<SpeakingState>(SpeakingState.IDLE);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentTopic, setCurrentTopic] = useState<DailyTopic | null>(null);
  const [lastFeedback, setLastFeedback] = useState<Feedback | null>(null);
  const [transcript, setTranscript] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  
  // Refs
  const messagesRef = useRef<Message[]>([]); 
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const processingRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const addLog = (msg: string) => {
    console.log(msg);
    setLogs(prev => [msg, ...prev].slice(0, 20));
  };

  // --- Persistence & Init ---

  // Load level on mount
  useEffect(() => {
    const savedLevel = localStorage.getItem('fluent_level');
    if (savedLevel) {
      addLog("Restored level: " + savedLevel);
      setUserLevel(savedLevel);
      setMode(AppMode.DASHBOARD);
    }
  }, []);

  const saveLevel = (lvl: string) => {
    localStorage.setItem('fluent_level', lvl);
    setUserLevel(lvl);
    addLog("Level saved: " + lvl);
  };

  // Watchdog: Prevent infinite processing state
  useEffect(() => {
    let timer: any;
    if (speakingState === SpeakingState.PROCESSING) {
      timer = setTimeout(() => {
        addLog("Watchdog: Processing timeout. Force IDLE.");
        setSpeakingState(SpeakingState.IDLE);
        processingRef.current = false;
      }, 16000); // slightly longer than API timeout
    }
    return () => clearTimeout(timer);
  }, [speakingState]);

  // --- Speech Logic ---

  const speakText = useCallback((text: string) => {
    if (!text) return false;
    if (synthRef.current.speaking) synthRef.current.cancel();
    
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = synthRef.current.getVoices();
      const preferredVoice = voices.find(v => v.name.includes('Google US English')) || voices.find(v => v.lang === 'en-US');
      if (preferredVoice) utterance.voice = preferredVoice;
      
      // Safety timeout for TTS starting
      const startTimeout = setTimeout(() => {
        if (speakingState !== SpeakingState.SPEAKING) {
           addLog("TTS failed to fire onstart");
           setSpeakingState(SpeakingState.IDLE);
        }
      }, 2000);

      utterance.onstart = () => {
        clearTimeout(startTimeout);
        setSpeakingState(SpeakingState.SPEAKING);
      };

      utterance.onend = () => {
        setSpeakingState(SpeakingState.IDLE);
      };

      utterance.onerror = (e) => {
        clearTimeout(startTimeout);
        addLog("TTS Error: " + e.error);
        setSpeakingState(SpeakingState.IDLE);
      };
      
      synthRef.current.speak(utterance);
      return true;
    } catch (e) {
      addLog("TTS Exception: " + e);
      return false;
    }
  }, [speakingState]);

  const handleSubmitAnswer = useCallback(async () => {
    const text = transcript.trim();
    if (!text) return;
    
    setTranscript('');
    if (processingRef.current) return;
    
    processingRef.current = true;
    setSpeakingState(SpeakingState.PROCESSING);
    addLog(`Submitting: "${text.substring(0, 20)}..."`);

    const currentHistory = messagesRef.current;
    const newHistory = [...currentHistory, { role: 'user', text } as Message];
    setMessages(newHistory);

    let speechStarted = false;

    try {
      if (mode === AppMode.ONBOARDING) {
        const result = await GeminiService.generatePlacementQuestion(newHistory);
        
        if (result.isFinished) {
          const lvl = result.level || 'A2';
          saveLevel(lvl);
          setMode(AppMode.DASHBOARD);
          addLog("Assessment finished: " + lvl);
        } else {
          if (result.question) {
             setMessages(prev => [...prev, { role: 'model', text: result.question! }]);
             speechStarted = speakText(result.question);
          }
        }
      } else if (mode === AppMode.PRACTICE) {
        if (currentTopic) {
          const result = await GeminiService.evaluateTurn(currentTopic, newHistory, text, userLevel);
          
          if (result.error) addLog("API Warning: " + result.error);
          
          setLastFeedback(result.feedback);
          
          if (!result.complete) {
            if (result.nextResponse) {
                setMessages(prev => [...prev, { role: 'model', text: result.nextResponse }]);
                speechStarted = speakText(result.nextResponse);
            } else {
                addLog("Err: Empty AI response");
                // Fallback speech
                const fb = "I'm listening, could you continue?";
                speechStarted = speakText(fb);
                setMessages(prev => [...prev, { role: 'model', text: fb }]);
            }
          } else {
            setMode(AppMode.SUMMARY);
            const summaryText = "Great session! You've completed the practice.";
            speechStarted = speakText(summaryText);
          }
        }
      }
    } catch (error: any) {
      addLog("Submission Error: " + error.message);
    } finally {
      processingRef.current = false;
      // If speech wasn't triggered successfully, ensure we reset to IDLE
      if (!speechStarted && mode !== AppMode.DASHBOARD) {
          setSpeakingState(SpeakingState.IDLE);
      }
    }
  }, [mode, currentTopic, speakText, transcript, userLevel]);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) {
      const win = window as unknown as IWindow;
      const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false;
        recognitionRef.current.interimResults = true;
        recognitionRef.current.lang = 'en-US';

        recognitionRef.current.onstart = () => setSpeakingState(SpeakingState.LISTENING);
        
        recognitionRef.current.onresult = (event: any) => {
          let finalTrans = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTrans += event.results[i][0].transcript;
            } else {
               setTranscript(event.results[i][0].transcript);
            }
          }
          if (finalTrans) setTranscript(finalTrans);
        };

        recognitionRef.current.onerror = (event: any) => {
          addLog("Mic Error: " + event.error);
          setSpeakingState(SpeakingState.IDLE);
        };

        recognitionRef.current.onend = () => {
          if (speakingState === SpeakingState.LISTENING) {
            setSpeakingState(SpeakingState.IDLE);
          }
        };
      } else {
        alert("Speech Recognition API not supported.");
      }
    }
    setTranscript('');
    recognitionRef.current?.start();
  }, [speakingState]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setSpeakingState(SpeakingState.IDLE);
  }, []);

  const handleRetry = useCallback(() => {
    setTranscript('');
    setSpeakingState(SpeakingState.IDLE);
  }, []);

  // --- Game Actions ---

  const startOnboarding = async () => {
    setMode(AppMode.ONBOARDING);
    setMessages([]);
    setSpeakingState(SpeakingState.PROCESSING);
    addLog("Starting Assessment...");
    
    try {
        const result = await GeminiService.generatePlacementQuestion([]);
        setSpeakingState(SpeakingState.IDLE);
        if (result.question) {
            setMessages([{ role: 'model', text: result.question }]);
            speakText(result.question);
        }
    } catch (e) {
        addLog("Start Error: " + e);
        setSpeakingState(SpeakingState.IDLE);
    }
  };

  const handleManualSelect = (lvl: string) => {
    saveLevel(lvl);
    setMode(AppMode.DASHBOARD);
  };

  const startPractice = async () => {
    setMode(AppMode.PRACTICE);
    setMessages([]);
    setLastFeedback(null);
    setTranscript('');
    setSpeakingState(SpeakingState.PROCESSING);
    addLog("Generating Daily Topic...");
    
    try {
        const topic = await GeminiService.generateDailyTopic(userLevel);
        setCurrentTopic(topic);
        addLog(`Topic: ${topic.title}`);
        
        const introText = topic.openingLine || `Hi! Let's talk about ${topic.title}.`;
        setMessages([{ role: 'model', text: introText }]);
        
        setTimeout(() => {
            speakText(introText);
        }, 100);
    } catch (e) {
        addLog("Topic Gen Error: " + e);
        setSpeakingState(SpeakingState.IDLE);
        setMode(AppMode.DASHBOARD); // Go back if fails
    }
  };
  
  const retakeAssessment = useCallback(() => {
      localStorage.removeItem('fluent_level');
      setUserLevel('A2');
      setMode(AppMode.LANDING);
      setShowLevelSelector(false);
  }, []);

  // --- Render Views ---

  // 1. Landing View
  if (mode === AppMode.LANDING) {
    if (showLevelSelector) {
        return (
            <div className="h-full flex flex-col items-center bg-gray-900 p-6 overflow-y-auto">
                <div className="w-full max-w-2xl">
                    <button onClick={() => setShowLevelSelector(false)} className="flex items-center text-gray-400 hover:text-white mb-6">
                        <ArrowLeft className="mr-2" /> Back
                    </button>
                    <h2 className="text-3xl font-bold text-white mb-6 text-center">Select Your Level</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {Object.entries(CEFR_DESCRIPTIONS).map(([lvl, desc]) => (
                            <button 
                                key={lvl}
                                onClick={() => handleManualSelect(lvl)}
                                className="bg-gray-800 hover:bg-gray-700 border border-gray-700 p-6 rounded-xl text-left transition-all hover:shadow-lg hover:border-blue-500 group"
                            >
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-2xl font-bold text-blue-400 group-hover:text-blue-300">{lvl}</span>
                                    {lvl === userLevel && <CheckCircle className="text-green-500" />}
                                </div>
                                <p className="text-gray-300 text-sm">{desc}</p>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    return (
      <div className="h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-900 to-blue-900 p-6 text-center">
        <div className="mb-8 p-6 bg-white/5 rounded-full border border-white/10">
            <GraduationCap size={64} className="text-blue-300" />
        </div>
        <h1 className="text-5xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-teal-300">
          FluentFlow
        </h1>
        <p className="text-xl text-gray-300 mb-12 max-w-md">
          Master English speaking with AI roleplay scenarios tailored to your level.
        </p>
        
        <div className="flex flex-col gap-4 w-full max-w-xs">
            <button 
              onClick={startOnboarding}
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-8 rounded-xl shadow-lg transform transition hover:scale-105 flex items-center justify-center gap-2"
            >
              <Play size={24} /> Start Assessment
            </button>
            <button 
              onClick={() => setShowLevelSelector(true)}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium py-3 px-8 rounded-xl border border-gray-700 transition flex items-center justify-center gap-2"
            >
               I know my level (Skip)
            </button>
        </div>
      </div>
    );
  }

  // 2. Dashboard View
  if (mode === AppMode.DASHBOARD) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-900 p-6 relative">
        <div className="bg-gray-800 p-8 rounded-2xl shadow-2xl max-w-md w-full text-center border border-gray-700">
          <div className="text-6xl mb-4">🏆</div>
          <h2 className="text-3xl font-bold mb-2 text-white">Level: <span className="text-blue-400">{userLevel}</span></h2>
          <p className="text-blue-200 text-sm mb-6 font-medium px-4 py-2 bg-blue-900/30 rounded-lg inline-block">
            {CEFR_DESCRIPTIONS[userLevel]?.split(':')[1] || "Assessment complete."}
          </p>
          <p className="text-gray-400 mb-8">You are ready for your daily practice!</p>
          
          <button 
            onClick={startPractice}
            className="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-4 px-6 rounded-xl shadow-lg transform transition hover:scale-105 flex items-center justify-center gap-2"
          >
            <Mic size={24} /> Start Daily Task
          </button>
          
          <div className="mt-6 pt-6 border-t border-gray-700 flex justify-between">
            <button onClick={retakeAssessment} className="text-gray-500 text-xs hover:text-gray-300 underline">
               Retake Assessment
            </button>
            <button onClick={() => { setMode(AppMode.LANDING); setShowLevelSelector(true); }} className="text-gray-500 text-xs hover:text-gray-300 underline flex items-center gap-1">
               <Settings size={12}/> Change Level
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Summary View
  if (mode === AppMode.SUMMARY) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-900 p-6 text-center">
        <h2 className="text-3xl font-bold mb-4 text-white">Session Complete!</h2>
        <div className="flex gap-2 mb-8 justify-center">
          {[1,2,3,4,5].map(i => <Star key={i} className="w-8 h-8 text-yellow-400 fill-yellow-400" />)}
        </div>
        <p className="text-gray-300 mb-8">You've completed your daily speaking practice.</p>
        <button 
          onClick={() => setMode(AppMode.DASHBOARD)}
          className="bg-blue-600 hover:bg-blue-500 text-white py-3 px-8 rounded-full font-bold"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  // 4. Active Interaction View (Onboarding & Practice)
  const lastModelMessage = messages.filter(m => m.role === 'model').slice(-1)[0]?.text || "...";
  const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.text;
  
  // Counters
  const userTurns = messages.filter(m => m.role === 'user').length;
  const displayStep = mode === AppMode.ONBOARDING ? Math.min(userTurns + 1, 5) : userTurns;

  // Determine if we are in "Review Mode" (User spoke, stopped, hasn't submitted yet)
  const isReviewing = speakingState === SpeakingState.IDLE && transcript.length > 0;
  const isAnalyzingFinal = mode === AppMode.ONBOARDING && speakingState === SpeakingState.PROCESSING && userTurns >= 5;

  return (
    <div className="h-full flex flex-col bg-gray-900 relative overflow-hidden">
      {/* Header */}
      <div className="absolute top-0 left-0 w-full p-4 flex justify-between items-center z-10 bg-gradient-to-b from-black/50 to-transparent">
        <div className="text-white font-bold text-lg tracking-wider">FluentFlow</div>
        <div className="flex gap-2">
           <button onClick={() => setShowLogs(!showLogs)} className="p-1 text-gray-500 hover:text-gray-300"><Bug size={16}/></button>
          <div className="px-3 py-1 bg-gray-800 rounded-full text-xs text-gray-300 border border-gray-700 flex items-center gap-2">
            {mode === AppMode.ONBOARDING ? <HelpCircle size={12}/> : <Mic size={12}/>}
            {mode === AppMode.ONBOARDING ? 'Assessment' : 'Daily Practice'}
          </div>
        </div>
      </div>

      {/* Main Interaction Area */}
      <div className="flex-1 flex flex-col items-center justify-center relative px-4 space-y-6 mt-12">
        
        <div className="w-full max-w-md flex justify-center">
             <ProgressBar 
               current={displayStep} 
               total={5} 
               label={mode === AppMode.ONBOARDING ? "Placement Assessment" : "Practice Conversation"}
             />
        </div>

        <Avatar 
          speaking={speakingState === SpeakingState.SPEAKING} 
          imageUrl={mode === AppMode.ONBOARDING ? "https://picsum.photos/id/1/400/400" : "https://picsum.photos/id/64/400/400"} 
        />
        
        {/* Partner's Bubble */}
        <div className="bg-gray-800/80 backdrop-blur-md p-6 rounded-2xl rounded-tl-none max-w-xl w-full border border-white/10 self-center shadow-lg relative min-h-[100px] flex items-center justify-center transition-all">
           <p className="text-lg md:text-2xl text-white leading-relaxed font-medium text-center">
             {speakingState === SpeakingState.PROCESSING && messages.length === 0 
                ? <span className="flex items-center gap-2 animate-pulse"><Loader2 className="animate-spin"/> Preparing...</span> 
                : isAnalyzingFinal 
                ? <span className="flex items-center gap-2 text-blue-300"><Loader2 className="animate-spin"/> Analyzing your English level...</span>
                : lastModelMessage
             } 
           </p>
        </div>

        {/* User's Bubble */}
        <div className="w-full max-w-xl flex justify-end min-h-[60px]">
            {(transcript || lastUserMessage) && !isAnalyzingFinal && (
                <div className={`
                   bg-blue-600/80 backdrop-blur-md p-4 px-6 rounded-2xl rounded-tr-none max-w-[90%] border border-blue-400/30 transition-all duration-300
                   ${isReviewing ? 'ring-2 ring-yellow-400' : ''}
                `}>
                    <p className="text-white text-right text-lg">
                        {transcript || lastUserMessage}
                    </p>
                    {isReviewing && (
                      <p className="text-xs text-yellow-300 mt-2 font-bold uppercase tracking-wider text-right">Waiting to Submit...</p>
                    )}
                </div>
            )}
        </div>

        {/* Feedback Overlay */}
        {lastFeedback && mode === AppMode.PRACTICE && !transcript && (
          <div className="absolute bottom-32 left-0 w-full flex justify-center z-20 px-4 pointer-events-none">
             <div className="bg-white text-gray-900 p-5 rounded-xl shadow-2xl max-w-lg w-full animate-fade-in-up border-l-8 pointer-events-auto flex flex-col gap-3" style={{ borderColor: lastFeedback.isGood ? '#22c55e' : '#eab308' }}>
                <div className="flex justify-between items-start border-b border-gray-100 pb-2">
                  <h3 className="font-bold flex items-center gap-2 text-lg">
                     {lastFeedback.isGood ? <Sparkles className="text-green-600 fill-green-100" size={20} /> : <RefreshCcw className="text-yellow-600" size={20} />}
                     <span className={lastFeedback.isGood ? "text-green-700" : "text-yellow-700"}>
                        {lastFeedback.isGood ? "Polished Expression" : "Suggestion"}
                     </span>
                  </h3>
                  <div className="flex">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} size={16} className={i < (lastFeedback.score || 0) ? "text-yellow-400 fill-yellow-400" : "text-gray-200"} />
                    ))}
                  </div>
                </div>
                
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">The Tip</span>
                    <p className="text-gray-800 font-medium leading-snug">{lastFeedback.advice}</p>
                </div>

                {lastFeedback.correction && (
                  <div className="bg-blue-50 border border-blue-100 p-3 rounded-lg mt-1">
                     <div className="text-xs font-bold text-blue-400 uppercase tracking-wide mb-1">Better Way</div>
                     <div className="text-blue-900 font-medium">"{lastFeedback.correction}"</div>
                  </div>
                )}
             </div>
          </div>
        )}
      </div>

      {/* Controls Area */}
      <div className="bg-gray-800 p-6 pb-10 rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.5)] relative z-30">
        <div className="flex flex-col items-center gap-4">
           <div className="h-8 w-full flex justify-center">
             <Waveform active={speakingState === SpeakingState.LISTENING} />
           </div>
           
           <div className="text-gray-400 text-sm h-5 flex items-center gap-2 font-medium uppercase tracking-widest">
              {speakingState === SpeakingState.LISTENING ? <span className="text-red-400 animate-pulse">Listening...</span> : 
               speakingState === SpeakingState.PROCESSING ? <span className="text-blue-400 flex gap-2"><Loader2 className="animate-spin" size={14}/> {isAnalyzingFinal ? "Grading..." : "AI Thinking..."}</span> : 
               speakingState === SpeakingState.SPEAKING ? <span className="text-green-400">AI Speaking...</span> :
               isReviewing ? "Review your answer" :
               "Tap mic to answer"}
           </div>

           <div className="flex items-center gap-6">
             {isReviewing ? (
                <button 
                   onClick={handleRetry}
                   className="p-4 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition-all"
                   title="Retry Recording"
                >
                   <RotateCcw size={24} />
                </button>
             ) : (
                <button 
                  onClick={speakingState === SpeakingState.SPEAKING ? () => synthRef.current.cancel() : undefined}
                  className={`p-4 rounded-full transition bg-gray-700 hover:bg-gray-600 text-gray-300 ${speakingState === SpeakingState.SPEAKING ? 'opacity-100' : 'opacity-50'}`}
                >
                  <Volume2 size={24} />
                </button>
             )}

             {isReviewing ? (
                <button
                  onClick={handleSubmitAnswer}
                  className="w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all transform hover:scale-105 bg-green-500 hover:bg-green-400 border-4 border-gray-900"
                >
                  <Send size={40} className="text-white ml-1" />
                </button>
             ) : (
                <button
                  onClick={speakingState === SpeakingState.LISTENING ? stopListening : startListening}
                  disabled={speakingState === SpeakingState.PROCESSING || speakingState === SpeakingState.SPEAKING}
                  className={`
                    w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all transform hover:scale-105 border-4 border-gray-900
                    ${speakingState === SpeakingState.LISTENING ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400'}
                    disabled:bg-gray-600 disabled:cursor-not-allowed disabled:transform-none
                  `}
                >
                  {speakingState === SpeakingState.LISTENING ? <MicOff size={40} className="text-white" /> : <Mic size={40} className="text-white" />}
                </button>
             )}

              {mode === AppMode.PRACTICE && (
                 <button onClick={() => setMode(AppMode.SUMMARY)} className="p-4 rounded-full bg-gray-700 hover:bg-gray-600 text-red-400 opacity-50 hover:opacity-100">
                   <XCircle size={24} />
                 </button>
              )}
              {(mode === AppMode.ONBOARDING || isReviewing) && mode !== AppMode.PRACTICE && (
                 <div className="w-14"></div> 
              )}
           </div>
        </div>
      </div>

      {showLogs && (
          <div className="absolute bottom-0 left-0 w-full h-48 bg-black/95 text-green-400 p-2 font-mono text-xs overflow-y-auto z-50 border-t border-green-800">
             <div className="flex justify-between items-center mb-2 sticky top-0 bg-black/90 p-1">
                <span className="font-bold">Debug Console</span>
                <button onClick={() => setShowLogs(false)} className="text-gray-400 hover:text-white">Close</button>
             </div>
             {logs.map((log, i) => (
                 <div key={i} className="border-b border-green-900/30 py-1">{log}</div>
             ))}
          </div>
      )}
    </div>
  );
}