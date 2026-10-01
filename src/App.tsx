import { useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  connect,
  errorMessage,
  findContact,
  MAX_MESSAGE_LENGTH,
  normalizeRecipient,
  receiveNotifications,
  request,
  validateCredentials,
} from './api';
import type { Credentials } from './api';
import { chatReducer, initialState } from './chat';
import type { Chat, Delivery } from './chat';

type IconName = 'chat' | 'plus' | 'send' | 'exit' | 'back' | 'search';

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 1 1 21 11.5Z',
    plus: 'M12 5v14M5 12h14',
    send: 'm22 2-7 20-4-9-9-4 20-7ZM22 2 11 13',
    exit: 'M9 5H5v14h4m5-14 7 7-7 7m-6-7h13',
    back: 'm15 5-7 7 7 7',
    search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="send" />
      </span>
      <span>
        Telegram<span className="brand-caption">через GREEN-API</span>
      </span>
    </div>
  );
}

function Avatar({ chat }: { chat: Chat }) {
  const hue = [...chat.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  const showChatIcon = chat.name.startsWith('+') || /^\d+$/.test(chat.name);

  return (
    <span className="avatar" style={{ '--hue': hue } as CSSProperties}>
      {showChatIcon ? <Icon name="chat" /> : chat.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const time = (value: number) =>
  new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const day = (value: number) =>
  new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const statusText: Record<Delivery, string> = {
  sending: 'Отправляется',
  queued: 'Принято в очередь',
  sent: 'Отправлено',
  delivered: 'Доставлено',
  read: 'Прочитано',
  failed: 'Не удалось отправить',
};

const statusSymbol: Record<Delivery, string> = {
  sending: '◷',
  queued: '·',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  failed: '!',
};

function Login({ onConnect }: { onConnect: (credentials: Credentials) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    const data = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    controller.current = new AbortController();
    try {
      const credentials = validateCredentials({
        idInstance: String(data.get('idInstance')),
        apiTokenInstance: String(data.get('apiTokenInstance')),
        apiUrl: String(data.get('apiUrl')),
      });
      await connect(credentials, controller.current.signal);
      if (!controller.current.signal.aborted) {
        onConnect(credentials);
      }
    } catch (cause) {
      if (!controller.current.signal.aborted) {
        setError(errorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <Brand />
        <h1>
          Ваши сообщения.
          <br />В одном окне.
        </h1>
        <p className="muted">Подключите аккаунт Telegram и начните общение.</p>
        <form onSubmit={submit}>
          <label htmlFor="instance">ID инстанса</label>
          <input
            id="instance"
            name="idInstance"
            placeholder="Например, 4100123456"
            inputMode="numeric"
            autoComplete="off"
            required
            disabled={busy}
          />
          <label htmlFor="token">API-токен</label>
          <input
            id="token"
            name="apiTokenInstance"
            type="password"
            placeholder="apiTokenInstance"
            autoComplete="off"
            required
            disabled={busy}
          />
          <label htmlFor="api-url">API URL</label>
          <input
            id="api-url"
            name="apiUrl"
            type="url"
            defaultValue="https://4100.api.green-api.com"
            autoComplete="off"
            required
            disabled={busy}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary login-submit" disabled={busy}>
            {busy ? 'Подключаемся…' : 'Подключиться'}
            <Icon name="back" />
          </button>
        </form>
        <a
          className="external-link"
          href="https://console.green-api.com/"
          target="_blank"
          rel="noreferrer"
        >
          Открыть личный кабинет
        </a>
      </div>
    </main>
  );
}

function Session({ credentials, onLogout }: { credentials: Credentials; onLogout: () => void }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [contactError, setContactError] = useState('');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const session = useRef<AbortController | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const scrollEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const active = state.chats.find((chat) => chat.id === state.activeId);
  const draft = active ? (drafts[active.id] ?? '') : '';
  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    void receiveNotifications(
      credentials,
      controller.signal,
      (body) => dispatch({ type: 'webhook', body }),
      setConnectionError,
    );
    return () => controller.abort();
  }, [credentials]);
  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ block: 'end' });
  }, [active?.id, active?.messages.length]);
  useEffect(() => {
    setSendError('');
    composer.current?.focus();
  }, [active?.id]);

  function newChat() {
    setContactError('');
    modal.current?.showModal();
  }
  async function createChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || !session.current) {
      return;
    }
    const form = event.currentTarget;
    setContactError('');
    setCreating(true);
    const signal = session.current.signal;
    try {
      const recipient = String(new FormData(form).get('recipient'));
      const lookup = normalizeRecipient(recipient);
      const id = await findContact(credentials, recipient, signal);
      if (signal.aborted) {
        return;
      }
      dispatch({
        type: 'open',
        id,
        phone: 'phoneNumber' in lookup ? String(lookup.phoneNumber) : undefined,
        name: 'username' in lookup ? lookup.username : undefined,
      });
      setSearch('');
      modal.current?.close();
      form.reset();
    } catch (cause) {
      if (!signal.aborted) {
        setContactError(errorMessage(cause));
      }
    } finally {
      setCreating(false);
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !active ||
      !draft.trim() ||
      sending ||
      !session.current ||
      draft.length > MAX_MESSAGE_LENGTH
    ) {
      return;
    }
    const chatId = active.id;
    const text = draft.trim();
    const localId = crypto.randomUUID();
    const signal = session.current.signal;
    setSending(true);
    setSendError('');
    dispatch({
      type: 'send',
      chatId,
      message: { id: localId, text, timestamp: Date.now(), outgoing: true, status: 'sending' },
    });
    setDrafts((current) => ({ ...current, [chatId]: '' }));
    try {
      const result = await request<{ idMessage: string }>(credentials, 'sendMessage', {
        body: { chatId, message: text },
        signal,
      });
      if (!result?.idMessage) {
        throw new Error('Сервис не подтвердил отправку. Проверьте переписку перед повтором.');
      }
      if (!signal.aborted) {
        dispatch({ type: 'sent', chatId, localId, id: String(result.idMessage) });
      }
    } catch (cause) {
      if (signal.aborted) {
        return;
      }
      dispatch({ type: 'failed', chatId, localId });
      setDrafts((current) => ({ ...current, [chatId]: current[chatId] || text }));
      setSendError(
        `${errorMessage(cause)} При обрыве связи сообщение могло уйти — проверьте Telegram перед повтором.`,
      );
    } finally {
      setSending(false);
    }
  }

  const chats = state.chats.filter((chat) =>
    `${chat.name} ${chat.phone ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main className={`messenger ${active ? 'has-active' : ''}`}>
      <aside className="sidebar" aria-label="Чаты">
        <header className="sidebar-header">
          <Brand />
          <button
            className="icon-button"
            onClick={() => {
              session.current?.abort();
              onLogout();
            }}
            title="Выйти"
            aria-label="Выйти"
          >
            <Icon name="exit" />
          </button>
        </header>
        <div className="section-heading">
          <h1>Чаты</h1>
          <button
            className="icon-button accent"
            onClick={newChat}
            title="Новый чат"
            aria-label="Новый чат"
          >
            <Icon name="plus" />
          </button>
        </div>
        <label className="search">
          <Icon name="search" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск"
            aria-label="Поиск чатов"
          />
        </label>
        <nav className="chat-list" aria-label="Список чатов">
          {chats.map((chat) => (
            <button
              className={`chat-item ${chat.id === active?.id ? 'selected' : ''}`}
              key={chat.id}
              onClick={() => dispatch({ type: 'open', id: chat.id })}
              aria-current={chat.id === active?.id ? 'true' : undefined}
            >
              <Avatar chat={chat} />
              <span className="chat-info">
                <strong>{chat.name}</strong>
                <span>{chat.messages.at(-1)?.text ?? 'Напишите первое сообщение'}</span>
              </span>
              <span className="chat-meta">
                <time>{chat.messages.length ? time(chat.messages.at(-1)!.timestamp) : ''}</time>
                {chat.unread > 0 && (
                  <span className="unread" aria-label={`${chat.unread} непрочитанных`}>
                    {chat.unread}
                  </span>
                )}
              </span>
            </button>
          ))}
          {!chats.length && (
            <div className="sidebar-empty">
              <Icon name="chat" />
              <p>{search ? 'Чаты не найдены' : 'Здесь будут ваши чаты'}</p>
              {!search && (
                <button className="text-button" onClick={newChat}>
                  Начать общение
                </button>
              )}
            </div>
          )}
        </nav>
        <div className="connection" role="status">
          <span className={`status-dot ${connectionError ? 'offline' : ''}`} />
          <span>
            {connectionError ? 'Восстанавливаем соединение…' : 'Telegram подключён'}
            <small>Инстанс {credentials.idInstance}</small>
          </span>
        </div>
      </aside>

      <section
        className="conversation"
        aria-label={active ? `Переписка с ${active.name}` : 'Переписка'}
      >
        {connectionError && (
          <div className="connection-error" role="alert">
            {connectionError} Повторяем подключение автоматически.
          </div>
        )}
        {active ? (
          <>
            <header className="conversation-header">
              <button
                className="icon-button mobile-back"
                aria-label="Назад к чатам"
                onClick={() => dispatch({ type: 'back' })}
              >
                <Icon name="back" />
              </button>
              <Avatar chat={active} />
              <div>
                <h2>{active.name}</h2>
                <p>{active.phone ? `+${active.phone} · Telegram` : 'Telegram'}</p>
              </div>
            </header>
            <div
              className="messages"
              role="log"
              aria-label="Сообщения"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {!active.messages.length && (
                <div className="chat-start">
                  <span className="small-chat-icon">
                    <Icon name="chat" />
                  </span>
                  <h3>Начните разговор</h3>
                  <p>Отправьте первое сообщение в Telegram</p>
                </div>
              )}
              {active.messages.map((message, index) => (
                <div key={message.id}>
                  {(index === 0 ||
                    day(message.timestamp) !== day(active.messages[index - 1].timestamp)) && (
                    <div className="date-separator">{day(message.timestamp)}</div>
                  )}
                  <div className={`message-row ${message.outgoing ? 'outgoing' : 'incoming'}`}>
                    <div className={`bubble ${message.status === 'failed' ? 'failed' : ''}`}>
                      <p>{message.text}</p>
                      <div className="message-meta">
                        <time dateTime={new Date(message.timestamp).toISOString()}>
                          {time(message.timestamp)}
                        </time>
                        {message.status && (
                          <span
                            className={`delivery ${message.status}`}
                            title={statusText[message.status]}
                            aria-label={statusText[message.status]}
                          >
                            {statusSymbol[message.status]}
                          </span>
                        )}
                      </div>
                      {message.status === 'failed' && (
                        <small className="failed-label">Не удалось подтвердить отправку</small>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={scrollEnd} />
            </div>
            <div className="composer-area">
              {sendError && (
                <p className="error" role="alert">
                  {sendError}
                </p>
              )}
              <form className="composer" onSubmit={send}>
                <textarea
                  ref={composer}
                  value={draft}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [active.id]: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Написать сообщение…"
                  aria-label="Текст сообщения"
                  rows={1}
                  maxLength={MAX_MESSAGE_LENGTH}
                />
                <button
                  className="send-button"
                  type="submit"
                  aria-label="Отправить сообщение"
                  title="Отправить сообщение"
                  disabled={!draft.trim() || sending}
                >
                  <Icon name="send" />
                </button>
              </form>
              <div className="composer-hint">
                <span>Enter - отправить; Shift + Enter - новая строка</span>
                <span>
                  {draft.length} / {MAX_MESSAGE_LENGTH}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="welcome">
            <span className="welcome-icon">
              <Icon name="chat" />
            </span>
            <h2>Ближе, чем кажется</h2>
            <p>
              Выберите чат или начните новый разговор.
              <br />
              Сообщения и ответы появятся здесь.
            </p>
            <button className="primary" onClick={newChat}>
              <Icon name="plus" />
              Новый чат
            </button>
          </div>
        )}
      </section>
      <dialog
        ref={modal}
        className="new-chat-dialog"
        onCancel={(event) => {
          if (creating) {
            event.preventDefault();
          }
        }}
      >
        <form onSubmit={createChat}>
          <div className="dialog-heading">
            <h2>Новый чат</h2>
            <button
              className="icon-button"
              type="button"
              disabled={creating}
              aria-label="Закрыть"
              onClick={() => modal.current?.close()}
            >
              ×
            </button>
          </div>
          <label htmlFor="recipient">Номер телефона или @username</label>
          <input
            id="recipient"
            name="recipient"
            type="text"
            placeholder="+7 999 123-45-67 или @username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={creating}
            autoFocus
          />
          {contactError && (
            <p className="error" role="alert">
              {contactError}
            </p>
          )}
          <button className="primary" disabled={creating}>
            {creating ? 'Ищем в Telegram…' : 'Открыть чат'}
          </button>
        </form>
      </dialog>
    </main>
  );
}

export default function App() {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  return credentials ? (
    <Session credentials={credentials} onLogout={() => setCredentials(null)} />
  ) : (
    <Login onConnect={setCredentials} />
  );
}
