import { api, APIError } from "encore.dev/api";
import { secret } from "encore.dev/config";

// Type definitions
interface StoredMessage {
  sender_id: string;
  message: string;
  timestamp: string;
  is_ai?: boolean; // Internal flag, not exposed to users
}

interface JoinSessionRequest {
  user_id: string;
  session_id: string;
}

interface SendMessageRequest {
  session_id: string; // sender's user ID
  message: string;
}

interface AnswerRequest {
  user_id: string;
  guess: "ai" | "human";
}

interface LeaveSessionRequest {
  user_id: string;
}

interface ApiResponse {
  success: boolean;
  message: string;
}

interface ReceivedMessagesResponse {
  messages: string[];
}

interface AnswerResponse {
  correct: boolean;
}

interface SessionInfoResponse {
  session_id: string;
  participants: string[];
  message_count: number;
  session_type: "ai" | "human";
}

interface PendingCountResponse {
  count: number;
}

interface PingResponse {
  status: string;
}

// In-memory storage
const sessions = new Map<string, string[]>(); // session_id -> [user_id, ai_id or other_user_id]
const userToSession = new Map<string, string>(); // user_id -> session_id
const sessionMessages = new Map<string, StoredMessage[]>(); // session_id -> messages (cleared after receive)
const conversationHistory = new Map<string, StoredMessage[]>(); // session_id -> persistent conversation history
const sessionTypes = new Map<string, "ai" | "human">(); // session_id -> type
const aiSessions = new Set<string>(); // Track which sessions have AI

// Gemini API configuration
const geminiApiKey = secret("GEMINI_API_KEY");

// Generate AI response using Gemini API
async function generateAIResponse(
  sessionId: string,
  currentMessage: string,
): Promise<string> {
  try {
    // Check if API key is available
    const apiKey = geminiApiKey();
    if (!apiKey) {
      console.error("Gemini API key not found");
      return "hey whats up";
    }
    console.log("Gemini API key loaded successfully");

    // Get full conversation history from persistent storage
    const allMessages = conversationHistory.get(sessionId) || [];

    // Build conversation history for Gemini
    const geminiHistory = allMessages.map((msg) => ({
      role: msg.is_ai ? "model" : "user",
      parts: [{ text: msg.message }],
    }));

    // Add the current message
    geminiHistory.push({
      role: "user",
      parts: [{ text: currentMessage }],
    });

    // Add system prompt as the first message
    const systemPrompt = {
      role: "user",
      parts: [
        {
          text: "You are a chill teenager texting a friend. Be super casual with teen slang and typos. Keep responses short 5-6 words max. No punctuation ever. Expand greetings like hey wassup or yo whats good. Never reveal youre AI. Just vibe naturally.",
        },
      ],
    };

    console.log(
      "Sending request to Gemini API with",
      geminiHistory.length,
      "messages",
    );

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [systemPrompt, ...geminiHistory],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 300,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Log the full response for debugging
    console.log("Gemini API response:", JSON.stringify(data, null, 2));

    // More robust error checking
    if (
      data.candidates &&
      Array.isArray(data.candidates) &&
      data.candidates.length > 0
    ) {
      const candidate = data.candidates[0];
      if (
        candidate &&
        candidate.content &&
        candidate.content.parts &&
        Array.isArray(candidate.content.parts) &&
        candidate.content.parts.length > 0
      ) {
        const part = candidate.content.parts[0];
        if (part && part.text) {
          return part.text.trim();
        }
      }
    }

    // Log if we don't get expected format
    console.log("Gemini API returned unexpected format, using fallback");
    return "That's interesting! Tell me more.";
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    // Fallback response on error
    return "I see what you mean. What are your thoughts on that?";
  }
}

// Create AI session participant ID
function createAIParticipant(): string {
  return `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Join or create a session (with random AI matching)
export const joinSession = api(
  { expose: true, method: "POST", path: "/session/join" },
  async ({ user_id, session_id }: JoinSessionRequest): Promise<ApiResponse> => {
    const existingParticipants = sessions.get(session_id) || [];

    // Check if user is already in the session
    if (existingParticipants.includes(user_id)) {
      return {
        success: true,
        message: "Already in session",
      };
    }

    // Check if session is full (max 2 participants)
    if (existingParticipants.length >= 2) {
      throw APIError.resourceExhausted("Session is full");
    }

    // If this is a new session, randomly decide if it should be AI or wait for human
    if (existingParticipants.length === 0) {
      const shouldMatchWithAI = !session_id.startsWith("human");

      if (shouldMatchWithAI) {
        const aiParticipant = createAIParticipant();
        const participants = [user_id, aiParticipant];

        sessions.set(session_id, participants);
        userToSession.set(user_id, session_id);
        sessionTypes.set(session_id, "ai");
        aiSessions.add(session_id);
        sessionMessages.set(session_id, []);
        conversationHistory.set(session_id, []);

        return {
          success: true,
          message: `Joined session ${session_id}`,
        };
      } else {
        sessions.set(session_id, [user_id]);
        userToSession.set(user_id, session_id);
        sessionTypes.set(session_id, "human");
        sessionMessages.set(session_id, []);
        conversationHistory.set(session_id, []);

        return {
          success: true,
          message: `Joined session ${session_id}, waiting for another participant`,
        };
      }
    } else {
      // Join existing human session
      const updatedParticipants = [...existingParticipants, user_id];
      sessions.set(session_id, updatedParticipants);
      userToSession.set(user_id, session_id);

      return {
        success: true,
        message: `Joined session ${session_id}`,
      };
    }
  },
);

// Send a message (with automatic AI response)
export const send = api(
  { expose: true, method: "POST", path: "/message/send" },
  async ({
    session_id: sender_id,
    message,
  }: SendMessageRequest): Promise<ApiResponse> => {
    const sessionId = userToSession.get(sender_id);

    if (!sessionId) {
      throw APIError.notFound("User is not in any session");
    }

    const participants = sessions.get(sessionId) || [];
    if (participants.length < 2) {
      throw APIError.failedPrecondition(
        "Waiting for another participant to join the session",
      );
    }

    // Store user's message
    const userMessage: StoredMessage = {
      sender_id: sender_id,
      message: message,
      timestamp: new Date().toISOString(),
      is_ai: false,
    };

    // Store in both temporary messages and persistent conversation history
    const existingMessages = sessionMessages.get(sessionId) || [];
    const persistentHistory = conversationHistory.get(sessionId) || [];

    existingMessages.push(userMessage);
    persistentHistory.push(userMessage);

    // If this is an AI session, generate AI response immediately (1-to-1 mapping)
    if (aiSessions.has(sessionId)) {
      const aiParticipant = participants.find((p) => p.startsWith("ai_"));
      if (aiParticipant) {
        // Generate AI response synchronously to ensure 1-to-1 mapping
        const aiMessage = await generateAIResponse(sessionId, message);
        const aiResponse: StoredMessage = {
          sender_id: aiParticipant,
          message: aiMessage,
          timestamp: new Date().toISOString(),
          is_ai: true,
        };

        // Add AI response to both storages
        existingMessages.push(aiResponse);
        persistentHistory.push(aiResponse);
      }
    }

    sessionMessages.set(sessionId, existingMessages);

    return {
      success: true,
      message: "Message sent successfully",
    };
  },
);

// Receive messages from session partner
export const receive = api(
  { expose: true, method: "GET", path: "/receive/:sid" },
  async ({ sid }: { sid: string }): Promise<ReceivedMessagesResponse> => {
    const sessionId = userToSession.get(sid);

    if (!sessionId) {
      return { messages: [] };
    }

    const messages = sessionMessages.get(sessionId) || [];

    // Filter out messages sent by the same user
    const filteredMessages = messages.filter((msg) => msg.sender_id !== sid);

    // Clear consumed messages (keep only sender's own messages)
    const remainingMessages = messages.filter((msg) => msg.sender_id === sid);
    sessionMessages.set(sessionId, remainingMessages);

    // Return just the message strings
    return {
      messages: filteredMessages.map((msg) => msg.message),
    };
  },
);

// Answer API - user guesses if they're talking to AI or human
export const answer = api(
  { expose: true, method: "POST", path: "/answer" },
  async ({ user_id, guess }: AnswerRequest): Promise<AnswerResponse> => {
    const sessionId = userToSession.get(user_id);

    if (!sessionId) {
      throw APIError.notFound("User is not in any session");
    }

    const sessionType = sessionTypes.get(sessionId);
    if (!sessionType) {
      throw APIError.internal("Session type not found");
    }

    const isCorrect = guess === sessionType;

    return {
      correct: isCorrect,
    };
  },
);

// Leave a session
export const leaveSession = api(
  { expose: true, method: "POST", path: "/session/leave" },
  async ({ user_id }: LeaveSessionRequest): Promise<ApiResponse> => {
    const sessionId = userToSession.get(user_id);

    if (!sessionId) {
      throw APIError.notFound("User is not in any session");
    }

    // Remove user from session
    const participants = sessions.get(sessionId) || [];
    const updatedParticipants = participants.filter((id) => id !== user_id);

    if (updatedParticipants.length === 0) {
      // If no participants left, clean up the session
      sessions.delete(sessionId);
      sessionMessages.delete(sessionId);
      conversationHistory.delete(sessionId);
      sessionTypes.delete(sessionId);
      aiSessions.delete(sessionId);
    } else if (aiSessions.has(sessionId)) {
      // For AI sessions, if the human user leaves, clean up everything
      // (since AI participants aren't real users)
      sessions.delete(sessionId);
      sessionMessages.delete(sessionId);
      conversationHistory.delete(sessionId);
      sessionTypes.delete(sessionId);
      aiSessions.delete(sessionId);
    } else {
      sessions.set(sessionId, updatedParticipants);
    }

    userToSession.delete(user_id);

    return {
      success: true,
      message: "Left session successfully",
    };
  },
);

export const getSessionInfo = api(
  { expose: true, method: "GET", path: "/session/info/:sid" },
  async ({ sid }: { sid: string }): Promise<SessionInfoResponse> => {
    const sessionId = userToSession.get(sid);

    if (!sessionId) {
      throw APIError.notFound("User is not in any session");
    }

    const participants = sessions.get(sessionId) || [];
    const messages = sessionMessages.get(sessionId) || [];
    const sessionType = sessionTypes.get(sessionId) || "human";

    return {
      session_id: sessionId,
      participants: participants,
      message_count: messages.length,
      session_type: sessionType,
    };
  },
);

export const getPendingCount = api(
  { expose: true, method: "GET", path: "/messages/pending/:sid" },
  async ({ sid }: { sid: string }): Promise<PendingCountResponse> => {
    const sessionId = userToSession.get(sid);

    if (!sessionId) {
      return { count: 0 };
    }

    const messages = sessionMessages.get(sessionId) || [];
    const filteredMessages = messages.filter((msg) => msg.sender_id !== sid);

    return { count: filteredMessages.length };
  },
);

export const ping = api(
  { expose: true, method: "GET", path: "/ping" },
  async (): Promise<PingResponse> => {
    console.log(geminiApiKey());
    return { status: "pong" };
  },
);
