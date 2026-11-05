import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { sendAdminBookingNotification } from './notifications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '1509034539').split(',').map((id) => id.trim()).filter(Boolean));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ services: [], slots: [], bookings: [] }, null, 2));

function readStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function userFromInitData(initData) {
  if (!initData || !TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (receivedHash.length !== calculatedHash.length || !crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(calculatedHash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) return null;
  try { return JSON.parse(params.get('user') || '{}'); } catch { return null; }
}

function getRequestUser(req) {
  const telegramUser = userFromInitData(req.get('x-telegram-init-data') || '');
  if (telegramUser) return telegramUser;
  if (process.env.NODE_ENV !== 'production' && req.get('x-demo-admin') === '1') return { id: Number([...ADMIN_IDS][0] || 1509034539), first_name: 'Demo' };
  return null;
}

function requireUser(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Откройте приложение внутри Telegram.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_IDS.has(String(req.user?.id))) return res.status(403).json({ error: 'Доступ только для администратора.' });
  next();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/bootstrap', requireUser, (req, res) => {
  const store = readStore();
  const isAdmin = ADMIN_IDS.has(String(req.user.id));
  const visibleBookings = isAdmin ? store.bookings : store.bookings.filter((booking) => String(booking.userId) === String(req.user.id));
  res.json({ user: req.user, isAdmin, services: store.services.filter((service) => service.active), masters: store.masters || [], settings: store.settings || {}, news: store.news || [], reviews: store.reviews || [], advantages: store.advantages || [], slots: store.slots, bookings: visibleBookings });
});

app.post('/api/bookings', requireUser, (req, res) => {
  const { serviceId, slotId, masterId = 'anna', clientName = '', phone = '', comment = '' } = req.body || {};
  const store = readStore();
  const service = store.services.find((item) => item.id === serviceId && item.active);
  const slot = store.slots.find((item) => item.id === slotId && item.available);
  if (!service || !slot) return res.status(400).json({ error: 'Услуга или время уже недоступны.' });
  slot.available = false;
  const booking = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    userName: String(clientName).trim() || [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || 'Клиент',
    phone: String(phone).slice(0, 30),
    username: req.user.username || '',
    serviceId: service.id,
    serviceTitle: service.title,
    masterId,
    masterName: store.masters?.find((master) => master.id === masterId)?.name || 'Анна Смирнова',
    date: slot.date,
    time: slot.time,
    comment: String(comment).slice(0, 500),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  store.bookings.unshift(booking);
  writeStore(store);
  sendAdminBookingNotification({ booking, bot, adminChatId: TELEGRAM_ADMIN_CHAT_ID, readStore, writeStore }).catch((error) => console.error('Admin notification error:', error));
  res.status(201).json({ booking });
});

app.post('/api/admin/bookings/:id/notify', requireUser, requireAdmin, async (req, res) => {
  const store = readStore();
  const booking = store.bookings.find((item) => item.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Запись не найдена.' });
  const notification = await sendAdminBookingNotification({ booking, bot, adminChatId: TELEGRAM_ADMIN_CHAT_ID, readStore, writeStore });
  res.json({ notification });
});

app.post('/api/admin/services', requireUser, requireAdmin, (req, res) => {
  const { title, description = '', duration = 60, price = 0, category = 'Маникюр', image = '' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Укажите название услуги.' });
  const store = readStore();
  const service = { id: crypto.randomUUID(), title: String(title).slice(0, 80), description: String(description).slice(0, 120), category: String(category).slice(0, 40), image: String(image).slice(0, 300), duration: Number(duration), price: Number(price), active: true };
  store.services.push(service);
  writeStore(store);
  res.status(201).json({ service });
});

app.put('/api/admin/services/:id', requireUser, requireAdmin, (req, res) => {
  const store = readStore();
  const service = store.services.find((item) => item.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'Услуга не найдена.' });
  Object.assign(service, {
    title: req.body.title === undefined ? service.title : String(req.body.title).slice(0, 80),
    description: req.body.description === undefined ? service.description : String(req.body.description).slice(0, 120),
    category: req.body.category === undefined ? service.category : String(req.body.category).slice(0, 40),
    image: req.body.image === undefined ? service.image : String(req.body.image).slice(0, 300),
    duration: req.body.duration === undefined ? service.duration : Number(req.body.duration),
    price: req.body.price === undefined ? service.price : Number(req.body.price),
    active: req.body.active === undefined ? service.active : Boolean(req.body.active)
  });
  writeStore(store);
  res.json({ service });
});

app.delete('/api/admin/services/:id', requireUser, requireAdmin, (req, res) => {
  const store = readStore();
  const service = store.services.find((item) => item.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'Услуга не найдена.' });
  service.active = false;
  writeStore(store);
  res.json({ ok: true });
});

app.post('/api/admin/masters', requireUser, requireAdmin, (req, res) => {
  const { name, specialization = '', experience = '', rating = 5, image = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Укажите имя мастера.' });
  const store = readStore();
  const master = { id: crypto.randomUUID(), name: String(name).slice(0, 80), specialization: String(specialization).slice(0, 100), experience: String(experience).slice(0, 60), rating: Number(rating), image: String(image).slice(0, 300) };
  store.masters ||= [];
  store.masters.push(master);
  writeStore(store);
  res.status(201).json({ master });
});

app.post('/api/admin/blackouts', requireUser, requireAdmin, (req, res) => {
  const { date, time = '', reason = 'Недоступно' } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Дата указана неверно.' });
  const store = readStore();
  const id = `${date}-${time || 'all-day'}`;
  if (store.slots.some((slot) => slot.id === id)) return res.status(409).json({ error: 'Такое время уже добавлено.' });
  store.slots.push({ id, date, time, available: false, reason: String(reason).slice(0, 100) });
  writeStore(store);
  res.status(201).json({ slot: store.slots.at(-1) });
});

app.post('/api/admin/slots', requireUser, requireAdmin, (req, res) => {
  const { date, time } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return res.status(400).json({ error: 'Дата или время указаны неверно.' });
  const store = readStore();
  const id = `${date}-${time}`;
  if (store.slots.some((slot) => slot.id === id)) return res.status(409).json({ error: 'Такой слот уже есть.' });
  const slot = { id, date, time, available: true };
  store.slots.push(slot);
  store.slots.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  writeStore(store);
  res.status(201).json({ slot });
});

app.patch('/api/admin/bookings/:id', requireUser, requireAdmin, (req, res) => {
  const allowed = new Set(['pending', 'confirmed', 'cancelled', 'completed']);
  const { status } = req.body || {};
  if (!allowed.has(status)) return res.status(400).json({ error: 'Неизвестный статус.' });
  const store = readStore();
  const booking = store.bookings.find((item) => item.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Запись не найдена.' });
  booking.status = status;
  const slot = store.slots.find((item) => item.date === booking.date && item.time === booking.time);
  if (slot) slot.available = status === 'cancelled';
  writeStore(store);
  notifyBookingUpdate(booking).catch(() => {});
  res.json({ booking });
});

app.patch('/api/bookings/:id', requireUser, (req, res) => {
  const store = readStore();
  const booking = store.bookings.find((item) => item.id === req.params.id && String(item.userId) === String(req.user.id));
  if (!booking) return res.status(404).json({ error: 'Запись не найдена.' });
  const nextStatus = req.body?.status;
  if (nextStatus === 'rescheduled') {
    const nextSlot = store.slots.find((item) => item.id === req.body?.slotId && item.available);
    if (!nextSlot) return res.status(400).json({ error: 'Новое время уже занято.' });
    const oldSlot = store.slots.find((item) => item.date === booking.date && item.time === booking.time);
    if (oldSlot) oldSlot.available = true;
    nextSlot.available = false;
    booking.date = nextSlot.date;
    booking.time = nextSlot.time;
    booking.status = 'pending';
    writeStore(store);
    notifyBookingUpdate(booking).catch(() => {});
    return res.json({ booking });
  }
  if (nextStatus !== 'cancelled') return res.status(400).json({ error: 'Для клиента доступна отмена или перенос записи.' });
  booking.status = 'cancelled';
  const slot = store.slots.find((item) => item.date === booking.date && item.time === booking.time);
  if (slot) slot.available = true;
  writeStore(store);
  notifyBookingUpdate(booking).catch(() => {});
  res.json({ booking });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  next();
});

async function notifyBookingUpdate(booking) {
  if (!bot || !booking?.userId) return;
  const statusText = { confirmed: 'подтверждена', cancelled: 'отменена', completed: 'завершена', pending: 'ожидает подтверждения' }[booking.status] || booking.status;
  await bot.api.sendMessage(booking.userId, `Статус записи изменён\n\n${booking.serviceTitle}\n${booking.date} в ${booking.time}\nСтатус: ${statusText}`);
}

async function notifyReminders() {
  if (!bot) return;
  const store = readStore();
  const now = Date.now();
  let changed = false;
  for (const booking of store.bookings) {
    const visitAt = new Date(`${booking.date}T${booking.time || '00:00'}:00`).getTime();
    const hoursLeft = (visitAt - now) / 3600000;
    if (booking.status === 'confirmed' && !booking.reminderSentAt && hoursLeft > 0 && hoursLeft <= 24) {
      await bot.api.sendMessage(booking.userId, `Напоминание о визите\n\n${booking.serviceTitle}\n${booking.date} в ${booking.time}\n${booking.masterName || ''}`);
      booking.reminderSentAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

let bot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN.includes(':')) {
  bot = new Bot(TELEGRAM_BOT_TOKEN);
  bot.command('start', async (ctx) => {
    const keyboard = new Keyboard().webApp('Открыть запись', APP_URL).resized();
    await ctx.reply('Добро пожаловать в запись на ногти.', { reply_markup: keyboard });
  });
  bot.command('admin', async (ctx) => {
    if (!ADMIN_IDS.has(String(ctx.from.id))) return ctx.reply('У вас нет доступа к админке.');
    await ctx.reply('Админка салона готова:', { reply_markup: new InlineKeyboard().url('Открыть админку', APP_URL) });
  });
  bot.catch((error) => console.error('Telegram bot error:', error.error));
  bot.start().catch((error) => console.error('Telegram polling error:', error));
  setInterval(() => notifyReminders().catch((error) => console.error('Reminder error:', error)), 60 * 1000);
} else {
  console.warn('TELEGRAM_BOT_TOKEN не задан или имеет неверный формат. Сайт запустится, но Telegram-бот не будет подключен.');
}

app.listen(PORT, () => console.log(`Nails Mini App: ${APP_URL} (порт ${PORT})`));

