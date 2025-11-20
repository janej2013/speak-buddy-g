import { GoogleGenAI, Type } from "@google/genai";
import { Message, Feedback, DailyTopic } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const MODEL_FAST = "gemini-2.5-flash";

// Strict timeout for AI operations to prevent "Stuck" UI
const withTimeout = <T>(promise: Promise<T>, ms: number = 15000): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("AI Timeout")), ms))
  ]);
};

// Helper to clean AI response 
const cleanJSON = (text: string): string => {
  try {
    JSON.parse(text);
    return text;
  } catch (e) {
    // Try to extract from ```json ... ``` or just {...}
    // Improved regex to be non-greedy but capture full object
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return match[0];
    
    // Fallback: sometimes model returns just valid JSON without brackets if extremely confused (rare)
    return text;
  }
};

// --- Onboarding / Placement ---

export const generatePlacementQuestion = async (history: Message[]): Promise<{ question?: string; isFinished: boolean; level?: string }> => {
  const userTurnCount = history.filter(m => m.role === 'user').length;
  
  // --- FINAL EVALUATION PATH (Turn 5+) ---
  if (userTurnCount >= 5) {
    const prompt = `
      You are an expert English CEFR Level Evaluator.
      The user has completed the 5-question assessment.
      
      Conversation History:
      ${JSON.stringify(history)}

      Task:
      1. Analyze the user's grammar, vocabulary range, fluency, and sentence structure.
      2. Assign a CEFR level (A1, A2, B1, B2, C1, C2).
      
      Output JSON:
      {
        "level": "B1" 
      }
    `;

    try {
      const response = await withTimeout(ai.models.generateContent({
        model: MODEL_FAST,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              level: { type: Type.STRING }
            }
          }
        }
      }));
      
      const text = cleanJSON(response.text || "{}");
      const json = JSON.parse(text);
      return { isFinished: true, level: json.level || "A2" }; 
    } catch (e) {
      console.error("Evaluation error:", e);
      return { isFinished: true, level: "B1" }; // Safe fallback
    }
  }

  // --- QUESTION GENERATION PATH (Turns 0-4) ---
  const prompt = `
    You are an expert English CEFR Level Evaluator conducting a spoken placement test.
    
    History: ${JSON.stringify(history)}
    User Turn Count: ${userTurnCount}
    Max Turns: 5

    Task:
    1. If history is empty, ask: "Hi! Please introduce yourself."
    2. Else, generate the NEXT question based on the previous answer.
       - If answer was simple -> Ask simpler question.
       - If answer was fluent -> Ask harder question.
    3. Keep question under 15 words.

    Output JSON:
    {
      "question": "Your next question here"
    }
  `;

  try {
    const response = await withTimeout(ai.models.generateContent({
      model: MODEL_FAST,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
            type: Type.OBJECT,
            properties: {
                question: { type: Type.STRING }
            }
        }
      }
    }));
    const text = cleanJSON(response.text || "");
    if (!text) throw new Error("No response");
    const json = JSON.parse(text);
    return { question: json.question, isFinished: false };
  } catch (e) {
    console.error(e);
    // Fallback question to keep app moving
    return { question: "Could you tell me about your hobbies?", isFinished: false };
  }
};

// --- Daily Practice ---

export const generateDailyTopic = async (userLevel: string): Promise<DailyTopic> => {
  const levelGuide: Record<string, string> = {
    'A1': "Simple concrete tasks. Buying food, greetings.",
    'A2': "Routine exchanges. Directions, family, routine.",
    'B1': "Travel, describing experiences, dreams.",
    'B2': "Abstract topics, fluency, spontaneity.",
    'C1': "Complex professional or social interaction.",
    'C2': "Subtle nuances, idiomatic mastery."
  };
  
  const specificGuide = levelGuide[userLevel] || levelGuide['B1'];

  const prompt = `Generate a roleplay scenario for English practice.
  Target Level: ${userLevel}
  Guide: ${specificGuide}
  
  Output JSON:
  {
    "id": "unique_id",
    "title": "Short Title",
    "description": "Brief context",
    "scenario": "You are [role]. I am [role]. We are at [place].",
    "difficulty": "${userLevel}",
    "openingLine": "First line suitable for level ${userLevel}."
  }`;

  try {
    const response = await withTimeout(ai.models.generateContent({
      model: MODEL_FAST,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            scenario: { type: Type.STRING },
            difficulty: { type: Type.STRING },
            openingLine: { type: Type.STRING }
          }
        }
      }
    }));
    const text = cleanJSON(response.text || "");
    if (!text) throw new Error("No topic generated");
    return JSON.parse(text) as DailyTopic;
  } catch (e) {
    console.error("Topic Error:", e);
    return {
      id: "fallback",
      title: "Casual Chat",
      description: "A friendly chat.",
      scenario: "We are friends.",
      difficulty: userLevel,
      openingLine: "Hi there! How is your day going?"
    };
  }
};

export const evaluateTurn = async (
  topic: DailyTopic,
  history: Message[],
  lastUserMessage: string,
  userLevel: string
): Promise<{ feedback: Feedback; nextResponse: string; complete: boolean; error?: string }> => {
  const userTurns = history.filter(m => m.role === 'user').length;
  
  if (userTurns >= 5) {
    return {
      feedback: { isGood: true, advice: "Session complete! Great job.", score: 5 },
      nextResponse: "Thank you for chatting with me! See you tomorrow.",
      complete: true
    };
  }

  const prompt = `
    You are an expert English dialect coach acting as a roleplay partner.
    Scenario: ${topic.scenario}
    User Target Level: ${userLevel}
    User's Last Input: "${lastUserMessage}"

    YOUR DUAL TASK:
    1. CONTINUE THE ROLEPLAY: Generate a natural response as your character.
    2. PROVIDE COACHING FEEDBACK: Analyze the User's Input for ONE specific improvement.

    CRITICAL RULES FOR FEEDBACK (DO NOT IGNORE):
    - ABSOLUTELY NO GENERIC ADVICE (e.g., "Speak clearly", "Practice more", "Be confident").
    - FOCUS on ONE tangible improvement: Grammar, Vocabulary choice, or Natural Phrasing.
    - IF GRAMMAR ERROR: Pinpoint it. (e.g., "Use 'went' for past tense, not 'go'.")
    - IF PHRASING IS OK BUT WEAK: Suggest a native idiom/collocation. (e.g., "Say 'I'm exhausted' instead of 'very tired'.")
    - IF PERFECT: Suggest a sophisticated alternative suitable for C1 level.
    
    Output JSON:
    {
      "isGood": boolean, 
      "correction": "The specific improved version of the user's phrase",
      "advice": "The specific rule or reason (Max 15 words)",
      "score": number (1-5),
      "nextResponse": "Your roleplay response"
    }
  `;

  try {
    const response = await withTimeout(ai.models.generateContent({
      model: MODEL_FAST,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isGood: { type: Type.BOOLEAN },
            correction: { type: Type.STRING, nullable: true },
            advice: { type: Type.STRING },
            score: { type: Type.INTEGER },
            nextResponse: { type: Type.STRING }
          }
        }
      }
    }));
    
    let text = cleanJSON(response.text || "");
    if (!text) throw new Error("Empty response");
    
    const json = JSON.parse(text);

    return {
      feedback: {
        isGood: json.isGood,
        correction: json.correction,
        advice: json.advice || "Review your sentence structure.",
        score: json.score
      },
      nextResponse: json.nextResponse || "I see. Please continue.",
      complete: false
    };
  } catch (e: any) {
    return {
      feedback: { isGood: true, advice: "Good effort!", score: 3 },
      nextResponse: "Could you rephrase that? I didn't quite catch it.",
      complete: false,
      error: e.toString()
    };
  }
};