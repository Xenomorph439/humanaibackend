import { api } from "encore.dev/api";

// Type definitions
interface StoredMessage {
  sender_id: string;
  message: string;
  timestamp: string;
}

interface SendMessageRequest {
  session_id: string; // sender's user ID
  message: string;
}

interface JoinSessionRequest {
  user_id: string;
  session_id: string;
}

interface LeaveSessionRequest {
  user_id: string;
}

interface ApiResponse {
  success: boolean;
  message: string;
}

interface ReceivedMessagesResponse {
  messages: {
    sender_id: string;
    message: string;
    timestamp: string;
  }[];
}

interface SessionInfoResponse {
  session_id: string;
  participants: string[];
  message_count: number;
}

interface PendingCountResponse {
  count: number;
}

// In-memory storage
const sessions = new Map<string, string[]>(); // session_id -> [user1_id, user2_id]
const userToSession = new Map<string, string>(); // user_id -> session_id
const sessionMessages = new Map<string, StoredMessage[]>(); // session_id -> messages

// Join or create a session
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

    // Check if session is full (max 2 participants for DM)
    if (existingParticipants.length >= 2) {
      return {
        success: false,
        message: "Session is full",
      };
    }

    // Add user to session
    const updatedParticipants = [...existingParticipants, user_id];
    sessions.set(session_id, updatedParticipants);
    userToSession.set(user_id, session_id);

    // Initialize message array for session if it doesn't exist
    if (!sessionMessages.has(session_id)) {
      sessionMessages.set(session_id, []);
    }

    return {
      success: true,
      message: `Joined session ${session_id}`,
    };
  },
);

// Send a message to session partner
export const send = api(
  { expose: true, method: "POST", path: "/message/send" },
  async ({
    session_id: sender_id,
    message,
  }: SendMessageRequest): Promise<ApiResponse> => {
    // Find which session the sender is in
    const sessionId = userToSession.get(sender_id);

    if (!sessionId) {
      return {
        success: false,
        message: "User is not in any session",
      };
    }

    const participants = sessions.get(sessionId) || [];

    if (participants.length < 2) {
      return {
        success: false,
        message: "Waiting for another participant to join the session",
      };
    }

    // Create the message object
    const storedMessage: StoredMessage = {
      sender_id: sender_id,
      message: message,
      timestamp: new Date().toISOString(),
    };

    // Get existing messages for the session
    const existingMessages = sessionMessages.get(sessionId) || [];
    existingMessages.push(storedMessage);
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
    // Find which session the user is in
    const sessionId = userToSession.get(sid);

    if (!sessionId) {
      return { messages: [] };
    }

    // Get messages for this session
    const messages = sessionMessages.get(sessionId) || [];

    // Filter out messages sent by the same user
    const filteredMessages = messages.filter((msg) => msg.sender_id !== sid);

    // Clear consumed messages (keep only sender's own messages)
    const remainingMessages = messages.filter((msg) => msg.sender_id === sid);
    sessionMessages.set(sessionId, remainingMessages);

    return {
      messages: filteredMessages.map((msg) => ({
        sender_id: msg.sender_id,
        message: msg.message,
        timestamp: msg.timestamp,
      })),
    };
  },
);

// Leave a session
export const leaveSession = api(
  { expose: true, method: "POST", path: "/session/leave" },
  async ({ user_id }: LeaveSessionRequest): Promise<ApiResponse> => {
    const sessionId = userToSession.get(user_id);

    if (!sessionId) {
      return {
        success: false,
        message: "User is not in any session",
      };
    }

    // Remove user from session
    const participants = sessions.get(sessionId) || [];
    const updatedParticipants = participants.filter((id) => id !== user_id);

    if (updatedParticipants.length === 0) {
      // If no participants left, clean up the session
      sessions.delete(sessionId);
      sessionMessages.delete(sessionId);
    } else {
      sessions.set(sessionId, updatedParticipants);
    }

    // Remove user from user-to-session mapping
    userToSession.delete(user_id);

    return {
      success: true,
      message: "Left session successfully",
    };
  },
);

// Get pending message count
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
