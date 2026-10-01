import type { Webhook } from './api';

export type Delivery = 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  text: string;
  timestamp: number;
  outgoing: boolean;
  status?: Delivery;
}

export interface Chat {
  id: string;
  name: string;
  phone?: string;
  messages: Message[];
  unread: number;
}

export interface ChatState {
  chats: Chat[];
  activeId: string | null;
}

export type Action =
  | {
      type: 'open';
      id: string;
      phone?: string;
      name?: string;
    }
  | {
      type: 'back';
    }
  | {
      type: 'webhook';
      body: Webhook;
    }
  | {
      type: 'send';
      chatId: string;
      message: Message;
    }
  | {
      type: 'sent';
      chatId: string;
      localId: string;
      id: string;
    }
  | {
      type: 'failed';
      chatId: string;
      localId: string;
    };

export const initialState: ChatState = {
  chats: [],
  activeId: null,
};

function getIncomingText(body: Webhook): string | undefined {
  const { messageData } = body;

  if (messageData?.typeMessage === 'textMessage') {
    return messageData.textMessageData?.textMessage;
  }

  if (messageData?.typeMessage === 'extendedTextMessage') {
    return messageData.extendedTextMessageData?.text;
  }

  return undefined;
}

function updateDeliveryStatus(message: Message, messageId: string, status: Delivery): Message {
  if (message.id !== messageId || !message.outgoing) {
    return message;
  }

  const rank: Partial<Record<Delivery, number>> = {
    sending: 0,
    queued: 1,
    sent: 2,
    delivered: 3,
    read: 4,
  };
  const currentRank = rank[message.status ?? 'queued'] ?? 0;
  const nextRank = rank[status] ?? 0;

  if (status !== 'failed' && nextRank < currentRank) {
    return message;
  }

  return { ...message, status };
}

export function chatReducer(state: ChatState, action: Action): ChatState {
  if (action.type === 'back') {
    return { ...state, activeId: null };
  }

  if (action.type === 'open') {
    const exists = state.chats.some((chat) => chat.id === action.id);
    let chats: Chat[];

    if (exists) {
      chats = state.chats.map((chat) => {
        if (chat.id !== action.id) {
          return chat;
        }

        return {
          ...chat,
          unread: 0,
          phone: action.phone ?? chat.phone,
        };
      });
    } else {
      const fallbackName = action.phone ? `+${action.phone}` : action.id;
      const chat: Chat = {
        id: action.id,
        name: action.name || fallbackName,
        phone: action.phone,
        messages: [],
        unread: 0,
      };
      chats = [chat, ...state.chats];
    }

    return { chats, activeId: action.id };
  }

  if (action.type === 'webhook') {
    const { body } = action;

    if (body.typeWebhook === 'outgoingMessageStatus' && body.idMessage) {
      const statuses = ['sent', 'delivered', 'read', 'failed'];

      if (!statuses.includes(body.status ?? '')) {
        return state;
      }

      const messageId = body.idMessage;
      const status = body.status as Delivery;
      const chats = state.chats.map((chat) => {
        const messages = chat.messages.map((message) =>
          updateDeliveryStatus(message, messageId, status),
        );

        return { ...chat, messages };
      });

      return { ...state, chats };
    }

    if (
      body.typeWebhook !== 'incomingMessageReceived' ||
      !body.idMessage ||
      !body.senderData?.chatId
    ) {
      return state;
    }

    const text = getIncomingText(body);

    if (typeof text !== 'string' || !text) {
      return state;
    }

    const sender = body.senderData;
    const chatId = String(sender.chatId);
    let chat = state.chats.find((item) => item.id === chatId);

    if (chat?.messages.some((message) => message.id === body.idMessage)) {
      return state;
    }

    if (!chat) {
      let phone: string | undefined;
      const isPrivateChat = !sender.chatType || sender.chatType === 'user';

      if (sender.senderPhoneNumber && isPrivateChat) {
        phone = sender.senderPhoneNumber.toString();
      }

      chat = {
        id: chatId,
        name: sender.chatName || sender.senderName || chatId,
        phone,
        messages: [],
        unread: 0,
      };
    }

    const message: Message = {
      id: body.idMessage,
      text,
      timestamp: (body.timestamp ?? Date.now() / 1000) * 1000,
      outgoing: false,
    };
    const updated: Chat = {
      ...chat,
      name: sender.chatName || sender.senderName || chat.name,
      unread: state.activeId === chatId ? 0 : chat.unread + 1,
      messages: [...chat.messages, message],
    };

    return {
      ...state,
      chats: [updated, ...state.chats.filter((item) => item.id !== chatId)],
    };
  }

  const chats = state.chats.map((chat) => {
    if (chat.id !== action.chatId) {
      return chat;
    }

    if (action.type === 'send') {
      return { ...chat, messages: [...chat.messages, action.message] };
    }

    const messages = chat.messages.map((message): Message => {
      if (message.id !== action.localId) {
        return message;
      }

      if (action.type === 'sent') {
        return { ...message, id: action.id, status: 'queued' };
      }

      return { ...message, status: 'failed' };
    });

    return { ...chat, messages };
  });

  return { ...state, chats };
}
