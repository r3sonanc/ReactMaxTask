import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connect,
  findContact,
  normalizePhone,
  normalizeRecipient,
  receiveNotifications,
  request,
  validateCredentials,
  type Credentials,
  type Webhook,
} from './api';

const credentials: Credentials = {
  idInstance: '4100000001',
  apiTokenInstance: 'test-token',
  apiUrl: 'https://4100.api.green-api.com',
};
const base = `${credentials.apiUrl}/waInstance${credentials.idInstance}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GREEN-API contract', () => {
  it('normalizes international phone numbers and rejects malformed numbers', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizePhone('+375 (29) 123-45-67')).toBe('375291234567');
    expect(normalizePhone('+1 (202) 555-0100')).toBe('12025550100');
    expect(normalizePhone('+44 20 7946 0958')).toBe('442079460958');
    for (const invalid of ['+1234567890123456', '+123456', '7abc9991234567', '+0123456789', '']) {
      expect(() => normalizePhone(invalid)).toThrow();
    }
  });

  it('normalizes usernames without treating them as phone numbers', () => {
    expect(normalizeRecipient(' @example_user ')).toEqual({ username: '@example_user' });
    expect(normalizeRecipient('+44 20 7946 0958')).toEqual({ phoneNumber: 442079460958 });
    for (const invalid of [
      '@',
      '@user name',
      '@пользователь',
      '@user/name',
      `@${'a'.repeat(33)}`,
    ]) {
      expect(() => normalizeRecipient(invalid)).toThrow();
    }
  });

  it('accepts the console API origin and rejects URLs that could expose credentials', () => {
    expect(
      validateCredentials({
        ...credentials,
        idInstance: ' 4100000001 ',
        apiUrl: `${credentials.apiUrl}/`,
      }),
    ).toEqual(credentials);
    for (const apiUrl of [
      'http://4100.api.green-api.com',
      'https://api.green-api.com.evil.test',
      'https://evil.test',
      'https://user:password@api.green-api.com',
      `${credentials.apiUrl}/v3`,
      `${credentials.apiUrl}?token=x`,
    ])
      expect(() => validateCredentials({ ...credentials, apiUrl })).toThrow();
    expect(() => validateCredentials({ ...credentials, idInstance: '123/456' })).toThrow();
    expect(() =>
      validateCredentials({ ...credentials, apiTokenInstance: 'token?query' }),
    ).toThrow();
  });

  it('sends text using the Telegram waInstance method URL, JSON body and message identifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ idMessage: '1763115112345' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await request(credentials, 'sendMessage', {
      body: { chatId: '10000000', message: 'Привет' },
    });
    expect(result).toEqual({ idMessage: '1763115112345' });
    expect(fetchMock).toHaveBeenCalledWith(
      `${base}/sendMessage/test-token`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: '10000000', message: 'Привет' }),
        referrerPolicy: 'no-referrer',
      }),
    );
  });

  it('accepts both an empty response and JSON null when the notification queue times out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(json(null));
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 2; i++) {
      expect(
        await request(credentials, 'receiveNotification', { suffix: '?receiveTimeout=25' }),
      ).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledWith(
      `${base}/receiveNotification/test-token?receiveTimeout=25`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('resolves a phone into its canonical chatId and rejects unavailable accounts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ exist: true, chatId: '10000000', fromCache: true }))
      .mockResolvedValueOnce(json({ exist: false, chatId: '' }))
      .mockResolvedValueOnce(
        json({ status: false, reason: 'instance is starting or not authorized' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(await findContact(credentials, '+7 (999) 123-45-67', signal)).toBe('10000000');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${base}/checkAccount/test-token`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ phoneNumber: 79991234567 }),
      }),
    );
    await expect(findContact(credentials, '79991234567', signal)).rejects.toThrow();
    await expect(findContact(credentials, '79991234567', signal)).rejects.toThrow();
  });

  it('looks up usernames and phone numbers with mutually exclusive checkAccount fields', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(json({ exist: true, chatId: '10000000' })));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    expect(await findContact(credentials, ' @example_user ', signal)).toBe('10000000');
    expect(await findContact(credentials, '+1 (202) 555-0100', signal)).toBe('10000000');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${base}/checkAccount/test-token`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: '@example_user' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${base}/checkAccount/test-token`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ phoneNumber: 12025550100 }),
      }),
    );
  });

  it('explains the nested Telegram rate limit returned with HTTP 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        status: false,
        data: { status: 'fail', reason: 'rate_limit_exceeded', retryAfter: 11930619 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      findContact(credentials, '79991234567', new AbortController().signal),
    ).rejects.toThrow(/Telegram.*ограничил поиск/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves HTTP 469 as a Telegram restriction instead of a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ status: false, reason: 'Rate limited by messenger' }, 469)),
    );
    await expect(
      findContact(credentials, '@example_user', new AbortController().signal),
    ).rejects.toMatchObject({
      status: 469,
      message: expect.stringMatching(/Telegram.*ограничил/),
    });
  });

  it('connects only after the Telegram instance has completed authorization', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ stateInstance: 'authorized' }))
      .mockResolvedValueOnce(json({ stateInstance: 'notAuthorized' }))
      .mockResolvedValueOnce(json({ stateInstance: 'pendingPassword' }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await expect(connect(credentials, signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${base}/getStateInstance/test-token`,
      expect.objectContaining({ method: 'GET' }),
    );
    await expect(connect(credentials, signal)).rejects.toThrow(/не авторизован.*Telegram/);
    await expect(connect(credentials, signal)).rejects.toThrow(/не авторизован.*Telegram/);
  });

  it('retries a failed acknowledgement before polling again without processing the message twice', async () => {
    vi.useFakeTimers();
    const body: Webhook = { typeWebhook: 'incomingMessageReceived', idMessage: 'message-1' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ receiptId: 42, body }))
      .mockResolvedValueOnce(json({ error: 'temporary failure' }, 500))
      .mockResolvedValueOnce(json({ result: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const onNotification = vi.fn();
    const onConnection = vi.fn((error: string | null) => {
      if (error === null) {
        controller.abort();
      }
    });
    const polling = receiveNotifications(
      credentials,
      controller.signal,
      onNotification,
      onConnection,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onConnection).toHaveBeenCalledWith(expect.any(String));
    await vi.advanceTimersByTimeAsync(1000);
    await polling;
    expect(onNotification).toHaveBeenCalledExactlyOnceWith(body);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const index of [2, 3])
      expect(fetchMock).toHaveBeenNthCalledWith(
        index,
        `${base}/deleteNotification/test-token/42`,
        expect.objectContaining({ method: 'DELETE' }),
      );
  });

  it('aborts an in-flight long poll without reporting a connection error or processing anything', async () => {
    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const onNotification = vi.fn();
    const onConnection = vi.fn();
    const polling = receiveNotifications(
      credentials,
      controller.signal,
      onNotification,
      onConnection,
    );
    controller.abort();
    await polling;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onNotification).not.toHaveBeenCalled();
    expect(onConnection).not.toHaveBeenCalled();
  });

  it('acknowledges unsupported notifications so they do not block the shared queue', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ receiptId: 99, body: { typeWebhook: 'stateInstanceChanged' } }))
      .mockResolvedValueOnce(json({ result: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await receiveNotifications(
      credentials,
      controller.signal,
      () => {},
      () => controller.abort(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${base}/deleteNotification/test-token/99`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
