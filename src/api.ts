export interface Credentials {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl: string;
}

export const MAX_MESSAGE_LENGTH = 4096;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function validateCredentials(value: Credentials): Credentials {
  const idInstance = value.idInstance.trim();
  const apiTokenInstance = value.apiTokenInstance.trim();
  if (!/^\d+$/.test(idInstance) || !/^[\w-]+$/.test(apiTokenInstance)) {
    throw new Error('Проверьте ID инстанса и API-токен.');
  }
  let url: URL;
  try {
    url = new URL(value.apiUrl.trim());
  } catch {
    throw new Error('Введите корректный API URL из личного кабинета.');
  }
  if (
    url.protocol !== 'https:' ||
    !/^(?:[a-z0-9-]+\.)*api\.green-api\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !['', '/'].includes(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('API URL должен иметь вид https://4100.api.green-api.com.');
  }
  return { idInstance, apiTokenInstance, apiUrl: url.origin };
}

export function normalizePhone(value: string): string {
  if (!/^\+?[\d\s()-]+$/.test(value.trim())) {
    throw new Error('Введите номер телефона в международном формате.');
  }
  const phone = value.replace(/\D/g, '');
  if (!/^[1-9]\d{6,14}$/.test(phone)) {
    throw new Error('Введите номер с кодом страны: от 7 до 15 цифр.');
  }
  return phone;
}

export function normalizeRecipient(value: string): { phoneNumber: number } | { username: string } {
  const recipient = value.trim();
  if (recipient.startsWith('@')) {
    if (!/^@[a-zA-Z0-9_]{1,32}$/.test(recipient)) {
      throw new Error('Введите @username: латинские буквы, цифры и знак подчёркивания.');
    }
    return { username: recipient };
  }
  return { phoneNumber: Number(normalizePhone(recipient)) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
}

export async function request<T>(
  credentials: Credentials,
  method: string,
  options: {
    body?: unknown;
    verb?: 'GET' | 'POST' | 'DELETE';
    suffix?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { apiUrl, idInstance, apiTokenInstance } = credentials;
  const url = `${apiUrl}/waInstance${idInstance}/${method}/${apiTokenInstance}${options.suffix ?? ''}`;
  try {
    const response = await fetch(url, {
      method: options.verb ?? (options.body ? 'POST' : 'GET'),
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.any([
        AbortSignal.timeout(40_000),
        ...(options.signal ? [options.signal] : []),
      ]),
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'GREEN-API отклонил запрос. Проверьте данные и состояние инстанса.',
        401: 'Неверный ID инстанса или API-токен.',
        403: 'Доступ запрещён. Проверьте реквизиты и тариф инстанса.',
        404: 'Инстанс не найден. Проверьте ID и API URL.',
        429: 'Слишком много запросов. Попробуйте чуть позже.',
        469: 'Telegram временно ограничил запросы. Попробуйте позже.',
      };
      throw new ApiError(
        messages[response.status] ?? `Сервис временно недоступен (HTTP ${response.status}).`,
        response.status,
      );
    }
    const text = await response.text();
    return (text.trim() ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError('Нет ответа от GREEN-API. Проверьте интернет и API URL.');
  }
}

export async function connect(credentials: Credentials, signal: AbortSignal) {
  const state = await request<{ stateInstance: string }>(credentials, 'getStateInstance', {
    signal,
  });
  if (state?.stateInstance !== 'authorized') {
    throw new Error(
      'Инстанс не авторизован. Подключите аккаунт Telegram в личном кабинете GREEN-API.',
    );
  }
}

export async function findContact(
  credentials: Credentials,
  recipient: string,
  signal: AbortSignal,
) {
  const result = await request<{
    exist?: boolean;
    chatId?: string;
    status?: boolean;
    reason?: string;
    data?: { reason?: string };
  }>(credentials, 'checkAccount', {
    body: normalizeRecipient(recipient),
    signal,
  });
  if (result?.status === false) {
    if ((result.data?.reason ?? result.reason) === 'rate_limit_exceeded') {
      throw new Error('Telegram временно ограничил поиск контактов. Попробуйте позже.');
    }
    throw new Error(
      'Не удалось проверить аккаунт. Проверьте авторизацию инстанса и повторите попытку.',
    );
  }
  if (!result?.exist || !result.chatId) {
    throw new Error(
      'Аккаунт Telegram не найден или скрыт настройками приватности. Попробуйте @username.',
    );
  }
  return String(result.chatId);
}

export interface Webhook {
  typeWebhook: string;
  idMessage?: string;
  timestamp?: number;
  chatId?: string;
  status?: string;
  senderData?: {
    chatId?: string;
    chatType?: string;
    chatName?: string;
    senderName?: string;
    senderPhoneNumber?: number;
  };
  messageData?: {
    typeMessage?: string;
    textMessageData?: { textMessage?: string };
    extendedTextMessageData?: { text?: string };
  };
}

export interface Notification {
  receiptId: number;
  body: Webhook;
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

// One consumer per mounted session. Every notification is acknowledged, including unsupported types.
export async function receiveNotifications(
  credentials: Credentials,
  signal: AbortSignal,
  onNotification: (body: Webhook) => void,
  onConnection: (error: string | null) => void,
) {
  let failures = 0;
  let pending: Notification | null = null;
  while (!signal.aborted) {
    try {
      if (!pending) {
        pending = await request<Notification | null>(credentials, 'receiveNotification', {
          suffix: '?receiveTimeout=25',
          signal,
        });
        if (signal.aborted) {
          return;
        }
        if (pending) {
          onNotification(pending.body);
        }
      }
      if (pending) {
        await request(credentials, 'deleteNotification', {
          verb: 'DELETE',
          suffix: `/${pending.receiptId}`,
          signal,
        });
        pending = null;
      } else {
        // Avoid a tight loop when a proxy answers immediately with an empty queue.
        await wait(250, signal);
      }
      if (signal.aborted) {
        return;
      }
      failures = 0;
      onConnection(null);
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      onConnection(errorMessage(error));
      await wait(Math.min(1000 * 2 ** failures++, 30_000), signal);
    }
  }
}
