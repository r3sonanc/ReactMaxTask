import { describe, expect, it } from 'vitest';
import { chatReducer, initialState, type ChatState, type Message } from './chat';
import type { Webhook } from './api';

const incoming = (chatId = '10000000', idMessage = 'message-1'): Webhook => ({
  typeWebhook: 'incomingMessageReceived',
  idMessage,
  timestamp: 1763115112,
  senderData: { chatId, chatName: 'Анна', senderPhoneNumber: 79991234567 },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Привет' } },
});
const receive = (state: ChatState, body = incoming()) =>
  chatReducer(state, { type: 'webhook', body });
const open = (state: ChatState, id = '10000000') =>
  chatReducer(state, { type: 'open', id, phone: '79991234567' });
const outgoing: Message = {
  id: 'local-1',
  text: 'Ответ',
  timestamp: 1763115113000,
  outgoing: true,
  status: 'sending',
};

describe('chat state', () => {
  it('creates a chat from an incoming message and converts seconds into milliseconds', () => {
    const state = receive(initialState);
    expect(state.activeId).toBeNull();
    expect(state.chats).toEqual([
      {
        id: '10000000',
        name: 'Анна',
        phone: '79991234567',
        unread: 1,
        messages: [{ id: 'message-1', text: 'Привет', timestamp: 1763115112000, outgoing: false }],
      },
    ]);
    expect(initialState.chats).toEqual([]);
  });

  it('does not expose zero or a group participant phone as the chat phone number', () => {
    const hiddenNumber = incoming();
    hiddenNumber.senderData = { chatId: '10000000', chatType: 'user', senderPhoneNumber: 0 };
    const privateChat = receive(initialState, hiddenNumber).chats[0];
    expect(privateChat.phone).toBeUndefined();
    expect(privateChat.name).toBe('10000000');

    const group = incoming('-10000000000000');
    group.senderData = {
      chatId: '-10000000000000',
      chatType: 'supergroup',
      chatName: 'Команда',
      senderPhoneNumber: 79991234567,
    };
    const groupChat = receive(initialState, group).chats[0];
    expect(groupChat.phone).toBeUndefined();
    expect(groupChat.name).toBe('Команда');
  });

  it('routes replies to a chat opened by username using the resolved canonical chatId', () => {
    let state = chatReducer(initialState, { type: 'open', id: '10000000', name: '@example_user' });
    expect(state.chats[0].name).toBe('@example_user');
    expect(state.chats[0].phone).toBeUndefined();
    state = chatReducer(state, { type: 'send', chatId: '10000000', message: outgoing });
    state = receive(state);
    expect(state.chats).toHaveLength(1);
    expect(state.activeId).toBe('10000000');
    expect(state.chats[0].unread).toBe(0);
    expect(state.chats[0].messages.map((message) => message.id)).toEqual(['local-1', 'message-1']);
  });

  it('deduplicates repeated notifications without increasing unread count', () => {
    const state = receive(initialState);
    expect(receive(state)).toBe(state);
    expect(state.chats[0].unread).toBe(1);
    expect(state.chats[0].messages).toHaveLength(1);
  });

  it('keeps text from extended messages containing links', () => {
    const body = incoming();
    body.messageData = {
      typeMessage: 'extendedTextMessage',
      extendedTextMessageData: { text: 'Ссылка: https://example.org' },
    };
    expect(receive(initialState, body).chats[0].messages[0].text).toBe(
      'Ссылка: https://example.org',
    );
  });

  it('routes messages by canonical chatId, counts inactive messages and clears unread when opened', () => {
    let state = open(initialState);
    state = receive(state);
    state = receive(state, incoming('20000000', 'message-2'));
    expect(state.activeId).toBe('10000000');
    expect(state.chats.map((chat) => [chat.id, chat.unread])).toEqual([
      ['20000000', 1],
      ['10000000', 0],
    ]);
    expect(state.chats[0].messages[0].id).toBe('message-2');
    state = open(state, '20000000');
    expect(state.chats).toHaveLength(2);
    expect(state.chats[0].unread).toBe(0);
    state = chatReducer(state, { type: 'back' });
    expect(state.activeId).toBeNull();
    expect(state.chats[0].messages).toHaveLength(1);
  });

  it('ignores status-independent notifications, media and malformed text events', () => {
    for (const body of [
      { typeWebhook: 'stateInstanceChanged' },
      { ...incoming(), messageData: { typeMessage: 'imageMessage' } },
      { ...incoming(), senderData: undefined },
      { ...incoming(), idMessage: undefined },
    ])
      expect(receive(initialState, body)).toBe(initialState);
  });

  it('keeps sends in their original chat and marks rejected sends as failed', () => {
    let state = open(open(initialState), '20000000');
    state = chatReducer(state, { type: 'send', chatId: '10000000', message: outgoing });
    state = chatReducer(state, { type: 'failed', chatId: '10000000', localId: 'local-1' });
    expect(state.activeId).toBe('20000000');
    expect(state.chats.find((chat) => chat.id === '20000000')!.messages).toEqual([]);
    expect(state.chats.find((chat) => chat.id === '10000000')!.messages[0]).toEqual({
      ...outgoing,
      status: 'failed',
    });
  });

  it('replaces the optimistic ID and handles delivery updates without regressing read status', () => {
    let state = chatReducer(open(initialState), {
      type: 'send',
      chatId: '10000000',
      message: outgoing,
    });
    state = chatReducer(state, {
      type: 'sent',
      chatId: '10000000',
      localId: 'local-1',
      id: 'server-1',
    });
    expect(state.chats[0].messages[0]).toEqual({ ...outgoing, id: 'server-1', status: 'queued' });
    for (const status of ['delivered', 'read', 'sent']) {
      state = receive(state, {
        typeWebhook: 'outgoingMessageStatus',
        idMessage: 'server-1',
        chatId: '10000000',
        status,
      });
    }
    expect(state.chats[0].messages[0].status).toBe('read');
    state = receive(state, {
      typeWebhook: 'outgoingMessageStatus',
      idMessage: 'server-1',
      status: 'failed',
    });
    expect(state.chats[0].messages[0].status).toBe('failed');
  });
});
