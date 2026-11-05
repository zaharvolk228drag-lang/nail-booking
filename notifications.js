import crypto from 'node:crypto';

const locks = new Set();

const statusLabels = {
  pending: 'Новая',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
  completed: 'Завершена'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function validateAdminBooking(booking, adminChatId) {
  const required = ['id', 'userName', 'phone', 'serviceTitle', 'date', 'time', 'masterName', 'status'];
  const missing = required.filter((key) => !String(booking?.[key] ?? '').trim());
  if (!String(adminChatId ?? '').trim()) missing.push('TELEGRAM_ADMIN_CHAT_ID');
  if (missing.length) throw new Error(`Недостаточно данных для уведомления: ${missing.join(', ')}`);
}

export function formatAdminBookingMessage(booking) {
  return [
    '<b>Новая запись на маникюр</b>',
    '',
    `<b>Клиент:</b> ${escapeHtml(booking.userName)}`,
    `<b>Телефон:</b> ${escapeHtml(booking.phone)}`,
    `<b>Услуга:</b> ${escapeHtml(booking.serviceTitle)}`,
    `<b>Дата:</b> ${escapeHtml(booking.date)}`,
    `<b>Время:</b> ${escapeHtml(booking.time)}`,
    `<b>Мастер:</b> ${escapeHtml(booking.masterName)}`,
    `<b>Комментарий:</b> ${escapeHtml(booking.comment || '—')}`,
    `<b>ID записи:</b> <code>${escapeHtml(booking.id)}</code>`,
    `<b>Статус:</b> ${escapeHtml(statusLabels[booking.status] || booking.status)}`
  ].join('\n');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends one admin notification for a persisted booking.
 * Telegram failures are returned as a result and never thrown to the booking request.
 */
export async function sendAdminBookingNotification({ booking, bot, adminChatId, readStore, writeStore, logger = console }) {
  if (!booking?.id || locks.has(booking.id)) return { sent: false, skipped: true, reason: 'in_flight' };
  locks.add(booking.id);
  try {
    const store = readStore();
    const stored = store.bookings?.find((item) => item.id === booking.id) || booking;
    if (stored.adminNotification?.status === 'sent') return { sent: false, skipped: true, reason: 'already_sent' };

    const attempts = Number(stored.adminNotification?.attempts || 0) + 1;
    stored.adminNotification = { status: 'sending', attempts, updatedAt: new Date().toISOString() };
    if (store.bookings?.some((item) => item.id === booking.id)) writeStore(store);

    try {
      validateAdminBooking(stored, adminChatId);
      if (!bot?.api?.sendMessage) throw new Error('Telegram bot is not configured');
      const message = await bot.api.sendMessage(adminChatId, formatAdminBookingMessage(stored), { parse_mode: 'HTML' });
      stored.adminNotification = {
        status: 'sent',
        attempts,
        sentAt: new Date().toISOString(),
        messageId: message?.message_id || null
      };
      if (store.bookings?.some((item) => item.id === booking.id)) writeStore(store);
      return { sent: true, messageId: message?.message_id || null };
    } catch (error) {
      stored.adminNotification = { status: 'failed', attempts, lastError: errorMessage(error), updatedAt: new Date().toISOString() };
      if (store.bookings?.some((item) => item.id === booking.id)) writeStore(store);
      logger.error?.('Admin notification failed', { bookingId: booking.id, error: errorMessage(error) });
      return { sent: false, failed: true, error: errorMessage(error) };
    }
  } finally {
    locks.delete(booking.id);
  }
}

export function notificationId() {
  return crypto.randomUUID();
}

