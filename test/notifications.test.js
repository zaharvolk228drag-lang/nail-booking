import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAdminBookingMessage, sendAdminBookingNotification } from '../notifications.js';

function createFixture() {
  return {
    id: 'booking-test-1',
    userName: 'Анна Петрова',
    phone: '+375291234567',
    serviceTitle: 'Маникюр + покрытие',
    date: '2026-11-06',
    time: '14:00',
    masterName: 'Анна Смирнова',
    comment: 'Нюдовый оттенок',
    status: 'pending'
  };
}

test('сохранённая запись отправляет одно уведомление администратору', async () => {
  const booking = createFixture();
  const store = { bookings: [{ ...booking }] };
  let sends = 0;
  let sentText = '';
  const bot = { api: { sendMessage: async (_chatId, text) => { sends += 1; sentText = text; return { message_id: 42 }; } } };
  const readStore = () => store;
  const writeStore = (next) => Object.assign(store, next);

  const first = await sendAdminBookingNotification({ booking, bot, adminChatId: '1509034539', readStore, writeStore, logger: { error() {} } });
  const second = await sendAdminBookingNotification({ booking, bot, adminChatId: '1509034539', readStore, writeStore, logger: { error() {} } });

  assert.equal(first.sent, true);
  assert.equal(second.reason, 'already_sent');
  assert.equal(sends, 1);
  assert.equal(store.bookings[0].adminNotification.status, 'sent');
  assert.match(sentText, /Анна Петрова/);
  assert.match(sentText, /Маникюр \+ покрытие/);
  assert.match(sentText, /booking-test-1/);
  assert.match(formatAdminBookingMessage(booking), /Статус:<\/b> Новая/);
});

test('ошибка Telegram не отменяет сохранённую запись и оставляет возможность повтора', async () => {
  const booking = createFixture();
  const store = { bookings: [{ ...booking }] };
  const bot = { api: { sendMessage: async () => { throw new Error('Telegram is temporarily unavailable'); } } };
  const errors = [];
  const readStore = () => store;
  const writeStore = (next) => Object.assign(store, next);

  const result = await sendAdminBookingNotification({ booking, bot, adminChatId: '1509034539', readStore, writeStore, logger: { error: (_message, details) => errors.push(details) } });

  assert.equal(result.failed, true);
  assert.equal(store.bookings[0].id, 'booking-test-1');
  assert.equal(store.bookings[0].adminNotification.status, 'failed');
  assert.equal(store.bookings[0].adminNotification.attempts, 1);
  assert.equal(errors.length, 1);
});

