# Telegram - GREEN-API Chat

## Локальный запуск
Нужен Node.js 22.12+

```sh
npm install
npm run dev
```

Откройте http://127.0.0.1:5173

## Публикация на хостинг
- `npm run build` - билд проекта в папку dist для публикации

## Реализация
- `src/api.ts` - проверка реквизитов через `getStateInstance`, поиск `checkAccount`, запросы API и последовательный цикл `receiveNotification - обработка - deleteNotification`
- `src/chat.ts` - состояние нескольких чатов, маршрутизация по chatId, дедупликация по idMessage и счётчики непрочитанных
- `src/App.tsx` - вход, список/поиск чатов, создание чата по номеру или юзернейму, переписка и выход
- `src/styles.css` - адаптивный интерфейс в стиле Макса + Телеграмма

## Ограничения
- сообщения до 4096 символов
- поддерживаются только текстовые сообщения. Файлы, изображения, голосовые сообщения и звонки не реализованы
- реквизиты, чаты и сообщения хранятся в памяти вкладки: обновление страницы или выход очищают их
- история переписки из Telegram не загружается. Приложение показывает сообщения, полученные во время работы, и доступные уведомления из очереди
- нужен авторизованный Telegram-инстанс GREEN-API и доступ к Интернету. Действуют ограничения тарифа и Telegram
- поиск по номеру может быть закрыт настройками приватности получателя. Можно использовать юзернейм или попросить получателя написать первым
- для одного инстанса следует использовать одну вкладку приложения и один потребитель уведомлений: очередь GREEN-API общая
- запросы к GREEN-API выполняются напрямую из браузера. Отдельного сервера и базы данных нет
- статус «Принято в очередь» не означает доставку!!! При ошибке связи перед повторной отправкой нужно проверить переписку в Telegram

## Документация API
- Формат запросов Telegram - https://green-api.com/telegram/docs/request-format/
- CheckAccount - https://green-api.com/telegram/docs/api/service/CheckAccount/
- SendMessage - https://green-api.com/telegram/docs/api/sending/SendMessage/
- Настройка HTTP API - https://green-api.com/telegram/docs/api/receiving/technology-http-api/
- ReceiveNotification - https://green-api.com/telegram/docs/api/receiving/technology-http-api/ReceiveNotification/
- DeleteNotification - https://green-api.com/telegram/docs/api/receiving/technology-http-api/DeleteNotification/
- Формат входящего текста - https://green-api.com/telegram/docs/api/receiving/notifications-format/incoming-message/TextMessage/
