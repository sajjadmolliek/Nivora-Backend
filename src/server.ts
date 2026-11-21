/**
 * ============================================================================
 *  NIVORA — SERVER (single file)
 *  Express + Mongoose + TypeScript. Contains: config, database models,
 *  security middleware, storefront API, order/payment engine, admin API.
 *  Money is stored as INTEGER POISHA (1 BDT = 100 poisha) everywhere.
 * ============================================================================
 */
import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

/* ==========================================================================
 * 1. CONFIG
 * ========================================================================== */

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const IS_PROD = NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 4000;
const DB_MEMORY = process.env.DB_MEMORY === '1' && !IS_PROD;
const TRUST_PROXY = process.env.TRUST_PROXY;

if (IS_PROD && !process.env.JWT_SECRET) {
  console.error('[fatal] JWT_SECRET is required in production.');
  process.exit(1);
}
if (IS_PROD && !process.env.MONGODB_URI) {
  console.error('[fatal] MONGODB_URI is required in production.');
  process.exit(1);
}

const JWT_SECRET: string = process.env.JWT_SECRET ?? crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — using an ephemeral development secret (sessions end on restart).');
}

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5001',
  'http://127.0.0.1:5001',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
].join(',');
const ALLOWED_ORIGINS = (process.env.APP_ORIGIN ?? DEFAULT_DEV_ORIGINS)
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_QTY_PER_LINE = 10;
// Only used by local automated tests; never relaxes limits in production.
const RL_MULT = !IS_PROD && process.env.RATE_LIMIT_RELAX === '1' ? 200 : 1;
const rl = (n: number) => Math.round(n * RL_MULT);
const MAX_LINES = 20;
const BCRYPT_COST = 12;

/* ==========================================================================
 * 2. SMALL UTILITIES
 * ========================================================================== */

class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const asyncRoute =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);
const toPoisha = (taka: number) => Math.round(taka * 100);
const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const clean = (v: string) => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
const newRequestId = () => crypto.randomBytes(8).toString('hex');

/** Strip Mongo operators / prototype pollution keys from nested input. */
function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

const PROHIBITED_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'iloveyou', 'admin123', 'letmein123', 'welcome123', 'nivora',
]);

function assertStrongPassword(pw: string) {
  if (pw.length < 10 || pw.length > 200) {
    throw new ApiError(400, 'Password must be between 10 and 200 characters.', 'weak_password');
  }
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
    throw new ApiError(400, 'Password must contain at least one letter and one number.', 'weak_password');
  }
  if (/^(.)\1+$/.test(pw) || PROHIBITED_PASSWORDS.has(pw.toLowerCase())) {
    throw new ApiError(400, 'That password is too easy to guess.', 'weak_password');
  }
}

/* ==========================================================================
 * 3. ZOD SCHEMAS (every request body is validated)
 * ========================================================================== */

const zId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const zPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(?:\+?88)?01[3-9]\d{8}$/.test(v), 'Enter a valid Bangladeshi mobile number');
const zEmail = z.string().trim().toLowerCase().email().max(160);
const zName = z.string().trim().min(2).max(80);

const registerSchema = z.object({
  name: zName,
  email: zEmail,
  phone: zPhone,
  password: z.string().min(10).max(200),
});

const loginSchema = z.object({
  email: zEmail,
  password: z.string().min(1).max(200),
});

const addressSchema = z.object({
  label: z.string().trim().max(30).optional().default('Home'),
  name: zName,
  phone: zPhone,
  area: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  district: z.string().trim().min(2).max(80),
  postcode: z.string().trim().max(10).optional().default(''),
  address: z.string().trim().min(5).max(300),
  isDefault: z.boolean().optional().default(false),
});

const variantInput = z.object({
  // Present when an existing option is edited — preserving it keeps carts and
  // pending orders pointing at the same variant id.
  _id: zId.optional(),
  label: z.string().trim().min(1).max(60),
  sku: z.string().trim().max(40).optional().default(''),
  price: z.number().int().min(0).max(10_000_000), // poisha
  compareAtPrice: z.number().int().min(0).max(10_000_000).optional().default(0),
  stock: z.number().int().min(0).max(100_000).default(0),
});

const imageInput = z.object({
  url: z
    .string()
    .trim()
    .max(600)
    // Absolute http(s) URLs, or same-origin paths such as the built-in /api/img art.
    .refine((u) => /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*)$/i.test(u), 'Image must be an http(s) URL or a /path'),
  alt: z.string().trim().max(120).optional().default(''),
});

const productInput = z.object({
  name: z.string().trim().min(2).max(140),
  slug: z.string().trim().max(160).optional(),
  description: z.string().trim().max(6000).optional().default(''),
  category: zId,
  images: z.array(imageInput).max(8).optional().default([]),
  variants: z.array(variantInput).min(1).max(20),
  isActive: z.boolean().optional().default(true),
  isFeatured: z.boolean().optional().default(false),
  tags: z.array(z.string().trim().max(30)).max(12).optional().default([]),
});

const cartItemSchema = z.object({
  productId: zId,
  variantId: zId,
  qty: z.number().int().min(1).max(MAX_QTY_PER_LINE),
});

const quoteSchema = z.object({
  items: z.array(cartItemSchema).max(MAX_LINES),
  couponCode: z.string().trim().max(30).optional(),
  district: z.string().trim().max(80).optional(),
});

const orderSchema = z.object({
  items: z.array(cartItemSchema).min(1).max(MAX_LINES),
  address: addressSchema,
  paymentMethod: z.enum(['cod', 'bkash', 'nagad', 'rocket']),
  senderPhone: zPhone.optional(),
  trxId: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9]{6,40}$/, 'Transaction id looks invalid')
    .optional(),
  couponCode: z.string().trim().max(30).optional(),
  note: z.string().trim().max(400).optional().default(''),
});

const couponInput = z.object({
  code: z.string().trim().min(3).max(30),
  type: z.enum(['percent', 'fixed']),
  value: z.number().int().min(1).max(10_000_000),
  minSubtotal: z.number().int().min(0).max(100_000_000).optional().default(0),
  maxDiscount: z.number().int().min(0).max(100_000_000).optional().default(0),
  usageLimit: z.number().int().min(0).max(1_000_000).optional().default(0),
  perUserLimit: z.number().int().min(1).max(100).optional().default(1),
  startsAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  isActive: z.boolean().optional().default(true),
});

const ORDER_STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];
const PAYMENT_STATUSES = ['unpaid', 'pending_verification', 'paid', 'failed', 'refunded'] as const;

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

/* ==========================================================================
 * 4. DATABASE MODELS
 * ========================================================================== */

const { Schema, model, Types } = mongoose;

const AddressSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, default: () => new Types.ObjectId() },
    label: { type: String, default: 'Home', maxlength: 30 },
    name: { type: String, required: true, maxlength: 80 },
    phone: { type: String, required: true, maxlength: 20 },
    area: { type: String, required: true, maxlength: 120 },
    city: { type: String, required: true, maxlength: 80 },
    district: { type: String, required: true, maxlength: 80 },
    postcode: { type: String, default: '', maxlength: 10 },
    address: { type: String, required: true, maxlength: 300 },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // Google sign-in accounts start without a phone or a password.
    phone: { type: String, default: '', maxlength: 20 },
    passwordHash: { type: String, default: null, select: false },
    googleId: { type: String, unique: true, sparse: true },
    role: { type: String, enum: ['customer', 'manager', 'admin'], default: 'customer', index: true },
    addresses: { type: [AddressSchema], default: [] },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const RefreshTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

const VariantSchema = new Schema({
  label: { type: String, required: true, trim: true, maxlength: 60 },
  sku: { type: String, trim: true, uppercase: true, maxlength: 40, default: '' },
  price: { type: Number, required: true, min: 0 },
  compareAtPrice: { type: Number, min: 0, default: 0 },
  stock: { type: Number, required: true, min: 0, default: 0 },
});

const ProductSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 140, index: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    description: { type: String, default: '', maxlength: 6000 },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    images: { type: [{ url: String, alt: String }], default: [] },
    variants: { type: [VariantSchema], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    isFeatured: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    sold: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);
ProductSchema.index({ name: 'text', tags: 'text' });

const CategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '', maxlength: 300 },
    image: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const OrderItemSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  image: { type: String, default: '' },
  variantLabel: { type: String, required: true },
  sku: { type: String, default: '' },
  unitPrice: { type: Number, required: true, min: 0 },
  qty: { type: Number, required: true, min: 1 },
  lineTotal: { type: Number, required: true, min: 0 },
});

const OrderSchema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [OrderItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0, default: 0 },
    shipping: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'BDT' },
    shippingAddress: { type: AddressSchema, required: true },
    payment: {
      method: { type: String, enum: ['cod', 'bkash', 'nagad', 'rocket'], required: true },
      status: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid', index: true },
      senderPhone: { type: String, default: '' },
      trxId: { type: String, default: '' },
      amount: { type: Number, required: true },
      verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      verifiedAt: { type: Date, default: null },
      note: { type: String, default: '', maxlength: 300 },
    },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    statusHistory: {
      type: [
        {
          status: { type: String, enum: ORDER_STATUSES },
          at: { type: Date, default: Date.now },
          by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          note: { type: String, default: '', maxlength: 300 },
        },
      ],
      default: [],
    },
    couponCode: { type: String, default: '' },
    note: { type: String, default: '', maxlength: 400 },
    adminNote: { type: String, default: '', maxlength: 400 },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true }
);
OrderSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
OrderSchema.index({ createdAt: -1 });

const CouponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 30 },
    type: { type: String, enum: ['percent', 'fixed'], required: true },
    value: { type: Number, required: true, min: 1 },
    minSubtotal: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: 0, min: 0 },
    usageLimit: { type: Number, default: 0, min: 0 },
    usedCount: { type: Number, default: 0, min: 0 },
    perUserLimit: { type: Number, default: 1, min: 1 },
    startsAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const ReviewSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 80 },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '', maxlength: 120 },
    body: { type: String, required: true, maxlength: 1200 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  },
  { timestamps: true }
);
ReviewSchema.index({ product: 1, user: 1 }, { unique: true });

const MessageSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    email: { type: String, required: true, maxlength: 160 },
    phone: { type: String, default: '', maxlength: 20 },
    subject: { type: String, default: '', maxlength: 140 },
    message: { type: String, required: true, maxlength: 2000 },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const AuditSchema = new Schema({
  actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actorEmail: { type: String, default: '' },
  action: { type: String, required: true, maxlength: 60 },
  targetType: { type: String, default: '', maxlength: 40 },
  targetId: { type: String, default: '', maxlength: 60 },
  meta: { type: Schema.Types.Mixed, default: {} },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '', maxlength: 300 },
  at: { type: Date, default: Date.now, index: true },
});

const SettingsSchema = new Schema(
  {
    key: { type: String, default: 'site', unique: true },
    storeName: { type: String, default: 'NIVORA', maxlength: 80 },
    tagline: { type: String, default: 'Readymade & Unstitched', maxlength: 160 },
    announcement: { type: String, default: 'Free delivery on orders over ৳3,000 · Nationwide delivery within 3-5 days', maxlength: 200 },
    phone: { type: String, default: '+880 1700 000000', maxlength: 30 },
    email: { type: String, default: 'care@nivora.com', maxlength: 120 },
    address: { type: String, default: 'Dhaka, Bangladesh', maxlength: 200 },
    facebook: { type: String, default: '', maxlength: 200 },
    instagram: { type: String, default: '', maxlength: 200 },
    whatsapp: { type: String, default: '', maxlength: 200 },
    freeShippingThreshold: { type: Number, default: 300000 }, // poisha
    codEnabled: { type: Boolean, default: true },
    walletEnabled: { type: Boolean, default: true },
    bkashNumber: { type: String, default: '01700-000000', maxlength: 30 },
    nagadNumber: { type: String, default: '01700-000000', maxlength: 30 },
    rocketNumber: { type: String, default: '01700-000000-1', maxlength: 30 },
    shippingZones: {
      type: [{ district: String, charge: Number }],
      default: [
        { district: 'Dhaka', charge: 7000 },
        { district: 'Chattogram', charge: 13000 },
      ],
    },
    defaultShippingCharge: { type: Number, default: 13000 },
    returnPolicy: { type: String, default: '7 days easy return on unused items with tags attached.', maxlength: 500 },
    // Floating support center (storefront widget)
    supportWhatsapp: { type: String, default: '', maxlength: 200 },
    supportMessenger: { type: String, default: '', maxlength: 200 },
    supportEmail: { type: String, default: '', maxlength: 120 },
  },
  { timestamps: true }
);

/* Uploaded artwork (support-center cover). Kept in Mongo so the image is served
 * by this API itself — no external image host, nothing on the device. */
const AssetSchema = new Schema({
  key: { type: String, unique: true, required: true },
  contentType: { type: String, default: 'image/jpeg', maxlength: 60 },
  size: { type: Number, default: 0 },
  data: { type: Buffer, required: true },
  updatedAt: { type: Date, default: Date.now },
});

const CounterSchema = new Schema({ _id: { type: String }, seq: { type: Number, default: 0 } });

/* Models are intentionally typed as `any`: schemas enforce structure at runtime
 * and every request body is validated by zod before it reaches a model. */
/* Schemas enforce structure at runtime and every request body is validated by
 * zod before it reaches a model, so the model handles are intentionally
 * untyped here to keep this single-file backend readable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (name: string, schema: mongoose.Schema): any => model(name, schema);
const User = m('User', UserSchema);
const RefreshToken = m('RefreshToken', RefreshTokenSchema);
const Product = m('Product', ProductSchema);
const Category = m('Category', CategorySchema);
const Order = m('Order', OrderSchema);
const Coupon = m('Coupon', CouponSchema);
const Review = m('Review', ReviewSchema);
const Message = m('Message', MessageSchema);
const Audit = m('Audit', AuditSchema);
const Settings = m('Settings', SettingsSchema);
const Asset = m('Asset', AssetSchema);
const Counter = m('Counter', CounterSchema);

/* ==========================================================================
 * 5. AUTH HELPERS
 * ========================================================================== */

type Role = 'customer' | 'manager' | 'admin';

interface AuthUser {
  _id: mongoose.Types.ObjectId;
  id: string;
  role: Role;
  email: string;
  name: string;
  isActive: boolean;
  tokenVersion: number;
  addresses: unknown[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

const ACCESS_COOKIE = 'bl_at';
const REFRESH_COOKIE = 'bl_rt';
const CSRF_COOKIE = 'bl_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * The default (strict) is correct when the storefront proxies the API on the
 * same site. If the storefront is hosted on another site, set
 * COOKIE_SAMESITE=lax|none and COOKIE_DOMAIN; SameSite=None requires HTTPS.
 */
const COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE ?? 'strict').toLowerCase();
if (!['strict', 'lax', 'none'].includes(COOKIE_SAMESITE)) {
  console.error('[fatal] COOKIE_SAMESITE must be strict, lax or none.');
  process.exit(1);
}
const SAMESITE = COOKIE_SAMESITE as 'strict' | 'lax' | 'none';

const cookieBase = {
  secure: IS_PROD || SAMESITE === 'none',
  sameSite: SAMESITE,
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
};

function setAccessCookie(res: Response, user: { _id: unknown; role: Role; tokenVersion: number }) {
  const token = jwt.sign(
    { sub: String(user._id), role: user.role, tv: user.tokenVersion, typ: 'access' },
    JWT_SECRET,
    { expiresIn: '15m', algorithm: 'HS256', issuer: 'nivora', audience: 'web' }
  );
  res.cookie(ACCESS_COOKIE, token, { ...cookieBase, httpOnly: true, path: '/', maxAge: ACCESS_TTL_MS });
}

async function issueRefreshToken(req: Request, res: Response, userId: mongoose.Types.ObjectId) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    user: userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    ip: req.ip ?? '',
    userAgent: (req.get('user-agent') ?? '').slice(0, 300),
  });
  res.cookie(REFRESH_COOKIE, raw, {
    ...cookieBase,
    httpOnly: true,
    path: '/api/auth',
    maxAge: REFRESH_TTL_MS,
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, httpOnly: true, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, httpOnly: true, path: '/api/auth' });
}

async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'nivora',
      audience: 'web',
    }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') return next();
    const user = (await User.findById(payload.sub)
      .select('name email role isActive tokenVersion addresses')
      .lean()) as AuthUser | null;
    if (!user || !user.isActive) return next();
    if (user.tokenVersion !== payload.tv) return next(); // tokens revoked
    req.user = user;
  } catch {
    /* invalid/expired token -> treated as signed out */
  }
  return next();
}

function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new ApiError(401, 'Please sign in to continue.', 'unauthorized'));
  return next();
}

function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new ApiError(401, 'Please sign in to continue.', 'unauthorized'));
    if (!roles.includes(req.user.role)) return next(new ApiError(403, 'You do not have access to this action.', 'forbidden'));
    return next();
  };
}

const staffOnly = requireRole('admin', 'manager');
const adminOnly = requireRole('admin');

/* ==========================================================================
 * 6. SHARED BUSINESS LOGIC
 * ========================================================================== */

async function getSettings() {
  const existing = await Settings.findOne({ key: 'site' });
  if (existing) return existing;
  return Settings.create({ key: 'site' });
}

async function publicSettings() {
  const s = await getSettings();
  // The cover lives in the Asset collection; expose a cache-busted URL only.
  const cover = await Asset.findOne({ key: 'support-cover' }).select('updatedAt').lean();
  return {
    storeName: s.storeName,
    tagline: s.tagline,
    announcement: s.announcement,
    phone: s.phone,
    email: s.email,
    address: s.address,
    facebook: s.facebook,
    instagram: s.instagram,
    whatsapp: s.whatsapp,
    supportWhatsapp: s.supportWhatsapp ?? '',
    supportMessenger: s.supportMessenger ?? '',
    supportEmail: s.supportEmail ?? '',
    supportCover: cover ? `/api/support-cover?v=${new Date((cover as { updatedAt: Date }).updatedAt).getTime()}` : '',
    freeShippingThreshold: s.freeShippingThreshold,
    codEnabled: s.codEnabled,
    walletEnabled: s.walletEnabled,
    bkashNumber: s.bkashNumber,
    nagadNumber: s.nagadNumber,
    rocketNumber: s.rocketNumber,
    shippingZones: s.shippingZones,
    defaultShippingCharge: s.defaultShippingCharge,
    returnPolicy: s.returnPolicy,
  };
}

function shippingFor(settings: Awaited<ReturnType<typeof getSettings>>, district?: string, subtotalAfterDiscount = 0) {
  if (settings.freeShippingThreshold > 0 && subtotalAfterDiscount >= settings.freeShippingThreshold) return 0;
  const zone = settings.shippingZones.find(
    (z: { district: string; charge: number }) => z.district.toLowerCase() === (district ?? '').toLowerCase()
  );
  return zone ? zone.charge : settings.defaultShippingCharge;
}

interface QuoteLine {
  productId: string;
  variantId: string;
  name: string;
  slug: string;
  image: string;
  variantLabel: string;
  unitPrice: number;
  compareAtPrice: number;
  qty: number;
  lineTotal: number;
  stock: number;
}

interface Quote {
  lines: QuoteLine[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  coupon: { code: string; type: string; value: number } | null;
  warnings: string[];
  currency: 'BDT';
}

async function validateCoupon(
  code: string | undefined,
  userId: mongoose.Types.ObjectId | undefined,
  subtotal: number
): Promise<{ coupon: { code: string; type: string; value: number } | null; discount: number; warnings: string[] }> {
  const warnings: string[] = [];
  if (!code) return { coupon: null, discount: 0, warnings };
  const normalized = code.trim().toUpperCase();
  const doc = await Coupon.findOne({ code: normalized }).lean();
  const now = new Date();
  if (!doc || !doc.isActive) return { coupon: null, discount: 0, warnings: ['This coupon code is not valid.'] };
  if (doc.startsAt && doc.startsAt > now) return { coupon: null, discount: 0, warnings: ['This coupon is not active yet.'] };
  if (doc.expiresAt && doc.expiresAt < now) return { coupon: null, discount: 0, warnings: ['This coupon has expired.'] };
  if (doc.usageLimit > 0 && doc.usedCount >= doc.usageLimit) {
    return { coupon: null, discount: 0, warnings: ['This coupon has reached its usage limit.'] };
  }
  if (subtotal < doc.minSubtotal) {
    return {
      coupon: null,
      discount: 0,
      warnings: [`Add ৳${((doc.minSubtotal - subtotal) / 100).toFixed(0)} more to use this coupon.`],
    };
  }
  if (userId) {
    const used = await Order.countDocuments({
      user: userId,
      couponCode: doc.code,
      status: { $nin: ['cancelled', 'returned'] },
    });
    if (used >= doc.perUserLimit) {
      return { coupon: null, discount: 0, warnings: ['You have already used this coupon.'] };
    }
  }
  let discount = doc.type === 'percent' ? Math.floor((subtotal * doc.value) / 100) : doc.value;
  if (doc.maxDiscount > 0) discount = Math.min(discount, doc.maxDiscount);
  discount = Math.min(discount, subtotal);
  return { coupon: { code: doc.code, type: doc.type, value: doc.value }, discount, warnings };
}

/**
 * Authoritative price calculation. The client never sends prices — only
 * product/variant ids and quantities — so tampering is impossible.
 */
async function buildQuote(
  items: Array<{ productId: string; variantId: string; qty: number }>,
  opts: { couponCode?: string; district?: string; userId?: mongoose.Types.ObjectId } = {}
): Promise<Quote> {
  const settings = await getSettings();
  const warnings: string[] = [];
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await Product.find({ _id: { $in: ids }, isActive: true }).lean();
  const byId = new Map<string, any>((products as any[]).map((p: any) => [String(p._id), p] as [string, any]));

  const lines: QuoteLine[] = [];
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) {
      warnings.push('An item in your cart is no longer available.');
      continue;
    }
    const variant = product.variants.find((v: { _id: unknown }) => String(v._id) === item.variantId);
    if (!variant) {
      warnings.push(`${product.name}: selected option is unavailable.`);
      continue;
    }
    if (variant.stock <= 0) {
      warnings.push(`${product.name} (${variant.label}) is out of stock.`);
      continue;
    }
    const qty = Math.min(item.qty, variant.stock, MAX_QTY_PER_LINE);
    if (qty < item.qty) warnings.push(`${product.name}: only ${qty} left in stock.`);
    lines.push({
      productId: String(product._id),
      variantId: String(variant._id),
      name: product.name,
      slug: product.slug,
      image: product.images?.[0]?.url ?? '',
      variantLabel: variant.label,
      unitPrice: variant.price,
      compareAtPrice: variant.compareAtPrice ?? 0,
      qty,
      lineTotal: variant.price * qty,
      stock: variant.stock,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const { coupon, discount, warnings: couponWarnings } = await validateCoupon(opts.couponCode, opts.userId, subtotal);
  warnings.push(...couponWarnings);
  const shipping = lines.length ? shippingFor(settings, opts.district, subtotal - discount) : 0;
  const total = Math.max(0, subtotal - discount + shipping);
  return { lines, subtotal, discount, shipping, total, coupon, warnings, currency: 'BDT' };
}

async function nextOrderNo() {
  const year = new Date().getFullYear();
  const counter = await Counter.findByIdAndUpdate(
    `order-${year}`,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();
  return `NV-${year}-${String(counter?.seq ?? 1).padStart(5, '0')}`;
}

async function audit(
  req: Request,
  action: string,
  targetType = '',
  targetId = '',
  meta: Record<string, unknown> = {}
) {
  try {
    await Audit.create({
      actor: req.user?._id ?? null,
      actorEmail: req.user?.email ?? '',
      action,
      targetType,
      targetId,
      meta,
      ip: req.ip ?? '',
      userAgent: (req.get('user-agent') ?? '').slice(0, 300),
    });
  } catch (err) {
    console.error('[audit] failed', err);
  }
}

function publicUser(user: {
  _id: unknown;
  name: string;
  email: string;
  phone: string;
  role: string;
  addresses?: unknown[];
}) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    addresses: user.addresses ?? [],
  };
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/* ==========================================================================
 * 7. APP + MIDDLEWARE
 * ========================================================================== */

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', Number(TRUST_PROXY) || TRUST_PROXY);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'https:', 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", ...ALLOWED_ORIGINS],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: IS_PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

/**
 * True when an Origin header points at this very host. Module scripts and fonts
 * are fetched in CORS mode even same-origin, so they carry an Origin header and
 * must not be mistaken for a cross-site call.
 */
function isSameOrigin(req: Request, origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const host = req.get('host');
    return !!host && parsed.host === host;
  } catch {
    return false;
  }
}

app.use(
  cors((req, cb) => {
    const origin = req.get('origin');
    if (!origin) return cb(null, { origin: false });
    if (isSameOrigin(req, origin) || ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) {
      return cb(null, {
        origin: true,
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', CSRF_HEADER, 'Idempotency-Key'],
        maxAge: 600,
      });
    }
    return cb(new ApiError(403, 'Origin not allowed.', 'cors'));
  })
);

app.set('query parser', 'simple'); // query values are strings/arrays only — never objects
app.use(express.json({ limit: '100kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser());

// Request id + minimal access log (no bodies, no PII)
app.use((req, res, next) => {
  req.requestId = newRequestId();
  res.setHeader('X-Request-Id', req.requestId);
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  next();
});

// Strip Mongo operators / prototype pollution from all untrusted input
app.use((req, _res, next) => {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.params) req.params = sanitizeValue(req.params) as typeof req.params;
  next();
});

// Give every browser a CSRF token cookie (double-submit pattern)
app.use((req, res, next) => {
  if (!req.cookies?.[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString('base64url');
    res.cookie(CSRF_COOKIE, token, { ...cookieBase, httpOnly: false, path: '/', maxAge: REFRESH_TTL_MS });
    req.cookies[CSRF_COOKIE] = token;
  }
  next();
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  // Only login/register are reachable before a session exists.
  if (req.path === '/auth/login' || req.path === '/auth/register') return next();

  const origin = req.get('origin');
  if (origin && !isSameOrigin(req, origin) && !ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) {
    return next(new ApiError(403, 'Cross-site request blocked.', 'csrf'));
  }
  const site = req.get('sec-fetch-site');
  if (!origin && site && site !== 'same-origin' && site !== 'none') {
    return next(new ApiError(403, 'Cross-site request blocked.', 'csrf'));
  }
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken.length !== headerToken.length) {
    return next(new ApiError(403, 'Security token missing. Please reload the page.', 'csrf'));
  }
  const a = Buffer.from(sha256(cookieToken));
  const b = Buffer.from(sha256(headerToken));
  if (!crypto.timingSafeEqual(a, b)) {
    return next(new ApiError(403, 'Security token mismatch. Please reload the page.', 'csrf'));
  }
  return next();
}

app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: rl(240),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: rl(20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: rl(20), standardHeaders: 'draft-7', legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: rl(30), standardHeaders: 'draft-7', legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: rl(60), standardHeaders: 'draft-7', legacyHeaders: false });

app.use('/api', requireCsrf);
app.use(authenticate);

/* ==========================================================================
 * 8. ROUTES — HEALTH / CSRF / SETTINGS
 * ========================================================================== */

const api = express.Router();

api.get('/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down', time: new Date().toISOString() });
});

api.get('/auth/csrf', (req, res) => {
  res.json({ csrfToken: req.cookies?.[CSRF_COOKIE] ?? '' });
});

/* Demo imagery: deterministic SVG art so the seeded catalogue looks finished
 * without depending on an external image host. Real photos should be uploaded
 * per product from the dashboard. */
const IMG_PALETTES: Array<[string, string, string]> = [
  ['#efe3d6', '#d8bd9f', '#6d4a32'],
  ['#e9e1ea', '#c9b6cf', '#54405c'],
  ['#dfe7e2', '#b4c9bd', '#3c5548'],
  ['#f3e6dc', '#e0b7a3', '#7c4030'],
  ['#e5e8ef', '#b9c3d8', '#3a4763'],
  ['#f5edda', '#dfcf9f', '#6b5a24'],
];

api.get('/img/:seed', (req, res) => {
  const seed = String(req.params.seed ?? '')
    .toLowerCase()
    .slice(0, 60)
    .replace(/[^a-z0-9-]/g, '');
  if (!seed) throw new ApiError(400, 'Invalid image seed.', 'bad_request');
  let hash = 7;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  const [light, mid, dark] = IMG_PALETTES[hash % IMG_PALETTES.length]!;
  const words = seed.split('-').filter(Boolean).slice(0, 2);
  const mono = words.map((w) => w.charAt(0).toUpperCase()).join('') || 'NV';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1200" width="900" height="1200" role="img">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs>
<rect width="900" height="1200" fill="url(#g)"/>
<circle cx="660" cy="300" r="300" fill="${dark}" opacity=".10"/>
<circle cx="210" cy="880" r="370" fill="#ffffff" opacity=".22"/>
<path d="M0 760 C 200 690 340 840 500 790 C 660 740 770 810 900 750 L900 1200 L0 1200 Z" fill="${dark}" opacity=".12"/>
<text x="450" y="640" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="220" fill="${dark}" opacity=".16" letter-spacing="10">${mono}</text>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(svg);
});

api.get('/settings', asyncRoute(async (_req, res) => {
  // Short cache: admin edits (including the support cover) should show up fast.
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.json({ settings: await publicSettings() });
}));

/* Support-center cover image, served by this API (self-hosted, no CDN needed).
 * The public settings URL carries a ?v= version, so the bytes can be cached. */
const SUPPORT_COVER_MAX = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** lean() hands Buffer fields back as BSON Binary, so normalise either shape. */
function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  const candidate = value as { value?: (asRaw?: boolean) => Uint8Array; buffer?: Uint8Array } | null;
  if (typeof candidate?.value === 'function') return Buffer.from(candidate.value(true));
  if (candidate?.buffer) return Buffer.from(candidate.buffer);
  return Buffer.alloc(0);
}

api.get('/support-cover', asyncRoute(async (_req, res) => {
  const asset = await Asset.findOne({ key: 'support-cover' }).lean();
  if (!asset) {
    res.status(404).json({ error: 'No support cover uploaded.', code: 'not_found' });
    return;
  }
  const bytes = toBuffer(asset.data);
  res.setHeader('Content-Type', asset.contentType || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(bytes);
}));

/* Product and category artwork uploaded from the dashboard. Each upload gets a
 * random key and is served from /api/asset/<key>, so the shop never hotlinks. */
api.get('/asset/:key', asyncRoute(async (req, res) => {
  const key = String(req.params.key ?? '').toLowerCase();
  if (!/^[a-z0-9-]{6,80}$/.test(key)) throw new ApiError(400, 'Invalid image key.', 'bad_request');
  const asset = await Asset.findOne({ key }).lean();
  if (!asset) throw new ApiError(404, 'Image not found.', 'not_found');
  const bytes = toBuffer(asset.data);
  res.setHeader('Content-Type', asset.contentType || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(bytes);
}));

api.get('/categories', asyncRoute(async (_req, res) => {
  const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
  const counts = await Product.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c: { _id: unknown; count: number }) => [String(c._id), c.count]));
  res.json({
    categories: categories.map((c: any) => ({
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      description: c.description,
      image: c.image,
      productCount: countMap.get(String(c._id)) ?? 0,
    })),
  });
}));

/* ==========================================================================
 * 9. ROUTES — AUTH
 * ========================================================================== */

api.post('/auth/register', registerLimiter, asyncRoute(async (req, res) => {
  const body = registerSchema.parse(req.body);
  assertStrongPassword(body.password);
  const existing = await User.findOne({ email: body.email }).select('_id').lean();
  if (existing) throw new ApiError(409, 'An account with this email already exists.', 'email_taken');
  const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
  const user = await User.create({
    name: body.name,
    email: body.email,
    phone: body.phone,
    passwordHash,
    role: 'customer',
  });
  setAccessCookie(res, user);
  await issueRefreshToken(req, res, user._id);
  await audit(req, 'auth.register', 'user', String(user._id));
  res.status(201).json({ user: publicUser(user) });
}));

api.post('/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const body = loginSchema.parse(req.body);
  const user = await User.findOne({ email: body.email }).select('+passwordHash +failedLogins +lockUntil');
  const generic = new ApiError(401, 'Email or password is incorrect.', 'bad_credentials');
  if (!user) {
    // Constant-ish work to blunt user-enumeration timing.
    await bcrypt.hash(body.password, 10);
    throw generic;
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new ApiError(423, 'Account temporarily locked after failed attempts. Try again later.', 'locked');
  }
  if (!user.isActive) throw new ApiError(403, 'This account has been disabled.', 'account_disabled');

  // Google-only accounts have no password to compare against.
  const ok = user.passwordHash ? await bcrypt.compare(body.password, user.passwordHash) : false;
  if (!ok) {
    const failed = (user.failedLogins ?? 0) + 1;
    const lock = failed >= 8 ? new Date(Date.now() + 15 * 60 * 1000) : null;
    await User.updateOne({ _id: user._id }, { $set: { failedLogins: lock ? 0 : failed, lockUntil: lock } });
    await audit(req, 'auth.login_failed', 'user', String(user._id), { email: body.email });
    throw generic;
  }

  await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockUntil: null, lastLoginAt: new Date() } });
  setAccessCookie(res, user);
  await issueRefreshToken(req, res, user._id);
  await audit(req, 'auth.login', 'user', String(user._id));
  res.json({ user: publicUser(user) });
}));

/* Google sign-in. The browser gets an ID token from Google Identity Services
 * and posts it here; the token is verified with Google before a session is
 * issued, so the client can never just claim an email address. */
const GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';

api.post('/auth/google', authLimiter, asyncRoute(async (req, res) => {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
  if (!clientId) throw new ApiError(503, 'Google sign-in is not configured on this server.', 'google_unavailable');
  const { credential } = z.object({ credential: z.string().trim().min(20).max(4096) }).parse(req.body);

  let info: { aud?: string; iss?: string; exp?: string; email?: string; email_verified?: string | boolean; name?: string; sub?: string };
  try {
    const upstream = await fetch(`${GOOGLE_TOKENINFO}?id_token=${encodeURIComponent(credential)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) throw new Error(`tokeninfo ${upstream.status}`);
    info = (await upstream.json()) as typeof info;
  } catch {
    throw new ApiError(401, 'Google could not verify that sign-in. Please try again.', 'bad_google_token');
  }

  if (info.aud !== clientId) throw new ApiError(401, 'That Google token was issued for another app.', 'bad_google_token');
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    throw new ApiError(401, 'That Google token could not be trusted.', 'bad_google_token');
  }
  if (!info.sub || !info.email) throw new ApiError(401, 'Google did not share an email address.', 'bad_google_token');
  if (!(info.email_verified === true || info.email_verified === 'true')) {
    throw new ApiError(401, 'Your Google email is not verified.', 'email_unverified');
  }

  const email = info.email.toLowerCase();
  let user = await User.findOne({ email });
  if (user) {
    if (!user.isActive) throw new ApiError(403, 'This account has been disabled.', 'account_disabled');
    if (!user.googleId) await User.updateOne({ _id: user._id }, { $set: { googleId: info.sub } });
  } else {
    user = await User.create({
      name: (info.name ?? email.split('@')[0] ?? 'Customer').slice(0, 80),
      email,
      googleId: info.sub,
      role: 'customer',
      lastLoginAt: new Date(),
    });
  }

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  setAccessCookie(res, user);
  await issueRefreshToken(req, res, user._id);
  await audit(req, 'auth.google_login', 'user', String(user._id));
  res.json({ user: publicUser(user) });
}));

api.post('/auth/refresh', authLimiter, asyncRoute(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) throw new ApiError(401, 'Session expired. Please sign in again.', 'no_refresh');
  const hash = sha256(raw);
  const stored = await RefreshToken.findOne({ tokenHash: hash });
  if (!stored) {
    clearAuthCookies(res);
    throw new ApiError(401, 'Session expired. Please sign in again.', 'no_refresh');
  }
  if (stored.revokedAt) {
    // Token reuse detected — revoke the whole family.
    await RefreshToken.updateMany({ user: stored.user, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await User.updateOne({ _id: stored.user }, { $inc: { tokenVersion: 1 } });
    clearAuthCookies(res);
    await audit(req, 'auth.refresh_reuse_detected', 'user', String(stored.user));
    throw new ApiError(401, 'Session is no longer valid. Please sign in again.', 'refresh_reuse');
  }
  if (stored.expiresAt < new Date()) {
    clearAuthCookies(res);
    throw new ApiError(401, 'Session expired. Please sign in again.', 'refresh_expired');
  }
  const user = await User.findById(stored.user);
  if (!user || !user.isActive) {
    clearAuthCookies(res);
    throw new ApiError(401, 'Session is no longer valid.', 'no_user');
  }

  const newRaw = crypto.randomBytes(48).toString('base64url');
  const newHash = sha256(newRaw);
  stored.revokedAt = new Date();
  stored.replacedByHash = newHash;
  await stored.save();
  await RefreshToken.create({
    user: user._id,
    tokenHash: newHash,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    ip: req.ip ?? '',
    userAgent: (req.get('user-agent') ?? '').slice(0, 300),
  });
  res.cookie(REFRESH_COOKIE, newRaw, { ...cookieBase, httpOnly: true, path: '/api/auth', maxAge: REFRESH_TTL_MS });
  setAccessCookie(res, user);
  res.json({ user: publicUser(user) });
}));

api.post('/auth/logout', asyncRoute(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) await RefreshToken.updateOne({ tokenHash: sha256(raw) }, { $set: { revokedAt: new Date() } });
  clearAuthCookies(res);
  res.json({ ok: true });
}));

api.get('/auth/me', asyncRoute(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = await User.findById(req.user._id).lean();
  res.json({ user: user ? publicUser(user) : null });
}));

api.patch('/auth/me', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ name: zName.optional(), phone: zPhone.optional() }).parse(req.body);
  const update: Record<string, unknown> = {};
  if (body.name) update.name = body.name;
  if (body.phone) update.phone = body.phone;
  if (!Object.keys(update).length) throw new ApiError(400, 'Nothing to update.', 'empty');
  const user = await User.findByIdAndUpdate(req.user!._id, { $set: update }, { new: true });
  res.json({ user: publicUser(user!) });
}));

api.post('/auth/password', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  const body = z
    .object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10).max(200) })
    .parse(req.body);
  assertStrongPassword(body.newPassword);
  const user = await User.findById(req.user!._id).select('+passwordHash');
  if (!user) throw new ApiError(401, 'Please sign in again.', 'unauthorized');
  const ok = user.passwordHash ? await bcrypt.compare(body.currentPassword, user.passwordHash) : false;
  if (!ok) throw new ApiError(400, 'Current password is incorrect.', 'bad_credentials');
  user.passwordHash = await bcrypt.hash(body.newPassword, BCRYPT_COST);
  user.tokenVersion += 1; // revoke every existing session
  user.passwordChangedAt = new Date();
  await user.save();
  await RefreshToken.updateMany({ user: user._id }, { $set: { revokedAt: new Date() } });
  clearAuthCookies(res);
  await audit(req, 'auth.password_changed', 'user', String(user._id));
  res.json({ ok: true, message: 'Password changed. Please sign in again.' });
}));

// Address book
api.post('/auth/addresses', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  const body = addressSchema.parse(req.body);
  const user = await User.findById(req.user!._id);
  if (!user) throw new ApiError(401, 'Please sign in again.', 'unauthorized');
  if (user.addresses.length >= 8) throw new ApiError(400, 'Address book is full (8 max).', 'address_limit');
  if (body.isDefault) user.addresses.forEach((a: { isDefault: boolean }) => (a.isDefault = false));
  if (!user.addresses.length) body.isDefault = true;
  user.addresses.push(body);
  await user.save();
  res.status(201).json({ addresses: user.addresses });
}));

api.patch('/auth/addresses/:id', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid address id.', 'bad_request');
  const body = addressSchema.partial().parse(req.body);
  const user = await User.findById(req.user!._id);
  if (!user) throw new ApiError(401, 'Please sign in again.', 'unauthorized');
  const addr = user.addresses.id(req.params.id);
  if (!addr) throw new ApiError(404, 'Address not found.', 'not_found');
  if (body.isDefault) user.addresses.forEach((a: { isDefault: boolean }) => (a.isDefault = false));
  Object.assign(addr, body);
  await user.save();
  res.json({ addresses: user.addresses });
}));

api.delete('/auth/addresses/:id', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid address id.', 'bad_request');
  const user = await User.findById(req.user!._id);
  if (!user) throw new ApiError(401, 'Please sign in again.', 'unauthorized');
  user.addresses.pull({ _id: req.params.id });
  await user.save();
  res.json({ addresses: user.addresses });
}));

/* ==========================================================================
 * 10. ROUTES — CATALOG
 * ========================================================================== */

function productCard(p: any, categoryName?: string) {
  const prices = (p.variants ?? []).map((v: any) => v.price);
  // Compare-at should belong to the cheapest option so the card discount is honest.
  const cheapest = [...(p.variants ?? [])].sort((a: any, b: any) => a.price - b.price)[0];
  return {
    id: String(p._id),
    name: p.name,
    slug: p.slug,
    description: p.description,
    category: categoryName ?? null,
    categoryId: String(p.category),
    images: p.images ?? [],
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    compareAtPrice: cheapest?.compareAtPrice ?? 0,
    inStock: (p.variants ?? []).some((v: any) => v.stock > 0),
    variants: p.variants ?? [],
    isFeatured: !!p.isFeatured,
    ratingAvg: p.ratingAvg ?? 0,
    ratingCount: p.ratingCount ?? 0,
    sold: p.sold ?? 0,
    tags: p.tags ?? [],
    createdAt: p.createdAt,
  };
}

api.get('/products', asyncRoute(async (req, res) => {
  const q = typeof req.query.q === 'string' ? clean(req.query.q).slice(0, 60) : '';
  const categorySlug = typeof req.query.category === 'string' ? req.query.category : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  const page = clampInt(req.query.page, 1, 1, 10_000);
  const limit = clampInt(req.query.limit, 24, 1, 60);
  const minPrice = clampInt(req.query.min, 0, 0, 10_000_000);
  const maxPrice = clampInt(req.query.max, 0, 0, 10_000_000);
  const featured = req.query.featured === '1';

  const filter: Record<string, unknown> = { isActive: true };
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' };
  if (featured) filter.isFeatured = true;
  if (categorySlug) {
    const cat = await Category.findOne({ slug: categorySlug.toLowerCase(), isActive: true }).lean();
    if (!cat) return res.json({ products: [], total: 0, page, pages: 0 });
    filter.category = cat._id;
  }
  if (minPrice || maxPrice) {
    filter['variants.price'] = {
      ...(minPrice ? { $gte: minPrice } : {}),
      ...(maxPrice ? { $lte: maxPrice } : {}),
    };
  }

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    'price-asc': { 'variants.price': 1 },
    'price-desc': { 'variants.price': -1 },
    popular: { sold: -1 },
  };

  const [total, docs] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort(sortMap[sort] ?? sortMap.newest).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  const catIds = [...new Set(docs.map((d: any) => String(d.category)))];
  const cats = await Category.find({ _id: { $in: catIds } }).lean();
  const catMap = new Map<string, string>(cats.map((c: any) => [String(c._id), String(c.name)]));

  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({
    products: docs.map((d: any) => productCard(d, catMap.get(String(d.category)))),
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  });
}));

api.get('/products/:slug', asyncRoute(async (req, res) => {
  const slug = String(req.params.slug ?? '').toLowerCase().slice(0, 160);
  if (!/^[a-z0-9\-]+$/.test(slug)) throw new ApiError(400, 'Invalid product link.', 'bad_request');
  const product = await Product.findOne({ slug, isActive: true }).lean();
  if (!product) throw new ApiError(404, 'Product not found.', 'not_found');
  const category = await Category.findById(product.category).lean();
  const related = await Product.find({
    isActive: true,
    category: product.category,
    _id: { $ne: product._id },
  })
    .limit(4)
    .lean();
  res.json({
    product: productCard(product, category?.name),
    related: related.map((r: any) => productCard(r, category?.name)),
  });
}));

api.get('/products/:slug/reviews', asyncRoute(async (req, res) => {
  const product = await Product.findOne({ slug: String(req.params.slug).toLowerCase() }).select('_id').lean();
  if (!product) throw new ApiError(404, 'Product not found.', 'not_found');
  const reviews = await Review.find({ product: product._id, status: 'approved' })
    .select('name rating title body createdAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ reviews });
}));

api.post('/products/:slug/reviews', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  const body = z
    .object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional().default(''), body: z.string().trim().min(5).max(1200) })
    .parse(req.body);
  const product = await Product.findOne({ slug: String(req.params.slug).toLowerCase(), isActive: true }).lean();
  if (!product) throw new ApiError(404, 'Product not found.', 'not_found');
  const bought = await Order.exists({ user: req.user!._id, 'items.product': product._id, status: 'delivered' });
  if (!bought) throw new ApiError(403, 'You can review a product after your order is delivered.', 'not_purchased');
  const existing = await Review.findOne({ product: product._id, user: req.user!._id }).lean();
  if (existing) throw new ApiError(409, 'You already reviewed this product.', 'duplicate');
  const review = await Review.create({
    product: product._id,
    user: req.user!._id,
    name: req.user!.name,
    rating: body.rating,
    title: body.title,
    body: body.body,
    status: 'pending',
  });
  res.status(201).json({ review: { id: String(review._id), status: review.status }, message: 'Thanks! Your review is awaiting approval.' });
}));

/* ==========================================================================
 * 11. ROUTES — CART QUOTE, COUPONS
 * ========================================================================== */

api.post('/cart/quote', asyncRoute(async (req, res) => {
  const body = quoteSchema.parse(req.body);
  const quote = await buildQuote(body.items, {
    couponCode: body.couponCode,
    district: body.district,
    userId: req.user?._id,
  });
  res.json({ quote });
}));

api.post('/coupons/validate', writeLimiter, asyncRoute(async (req, res) => {
  const body = z
    .object({ code: z.string().trim().min(1).max(30), subtotal: z.number().int().min(0).max(100_000_000) })
    .parse(req.body);
  const result = await validateCoupon(body.code, req.user?._id, body.subtotal);
  res.json(result);
}));

/* ==========================================================================
 * 12. ROUTES — ORDERS (the money path)
 * ========================================================================== */

api.post('/orders', orderLimiter, requireAuth, asyncRoute(async (req, res) => {
  const body = orderSchema.parse(req.body);
  const userId = req.user!._id;
  const idemHeader = req.get('Idempotency-Key');
  const idempotencyKey = idemHeader && /^[A-Za-z0-9_-]{8,80}$/.test(idemHeader) ? idemHeader : null;

  if (idempotencyKey) {
    const prior = await Order.findOne({ user: userId, idempotencyKey }).lean();
    if (prior) return res.status(200).json({ order: prior, idempotent: true });
  }

  const settings = await getSettings();
  if (body.paymentMethod === 'cod' && !settings.codEnabled) {
    throw new ApiError(400, 'Cash on delivery is currently unavailable.', 'payment_disabled');
  }
  if (body.paymentMethod !== 'cod') {
    if (!settings.walletEnabled) throw new ApiError(400, 'Mobile wallet payments are currently unavailable.', 'payment_disabled');
    if (!body.trxId || !body.senderPhone) {
      throw new ApiError(400, 'Send the money first, then enter your sender number and transaction id.', 'payment_details_required');
    }
  }

  const quote = await buildQuote(body.items, {
    couponCode: body.couponCode,
    district: body.address.district,
    userId,
  });
  if (!quote.lines.length) throw new ApiError(400, 'Your cart is empty or unavailable.', 'empty_cart');
  if (quote.warnings.length) {
    throw new ApiError(409, 'Your cart changed. Please review it again.', 'cart_changed', quote.warnings);
  }
  if (quote.total <= 0) throw new ApiError(400, 'Order total is invalid.', 'bad_total');

  // Reserve stock atomically — conditional update prevents overselling under concurrency.
  const reserved: Array<{ productId: string; variantId: string; qty: number }> = [];
  const rollback = async () => {
    for (const r of reserved) {
      await Product.updateOne(
        { _id: r.productId, 'variants._id': r.variantId },
        { $inc: { 'variants.$.stock': r.qty } }
      );
    }
  };

  try {
    for (const line of quote.lines) {
      const updated = await Product.findOneAndUpdate(
        { _id: line.productId, 'variants._id': line.variantId, 'variants.stock': { $gte: line.qty }, isActive: true },
        { $inc: { 'variants.$.stock': -line.qty, sold: line.qty } },
        { new: true }
      );
      if (!updated) {
        await rollback();
        throw new ApiError(409, `${line.name} (${line.variantLabel}) just went out of stock.`, 'out_of_stock');
      }
      reserved.push({ productId: line.productId, variantId: line.variantId, qty: line.qty });
    }

    if (quote.coupon) {
      const claimed = await Coupon.findOneAndUpdate(
        { code: quote.coupon.code, $or: [{ usageLimit: 0 }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
        { $inc: { usedCount: 1 } },
        { new: true }
      );
      if (!claimed) {
        await rollback();
        throw new ApiError(409, 'That coupon is no longer available.', 'coupon_exhausted');
      }
    }

    const orderNo = await nextOrderNo();
    const order = await Order.create({
      orderNo,
      user: userId,
      items: quote.lines.map((l) => ({
        product: l.productId,
        variantId: l.variantId,
        name: l.name,
        slug: l.slug,
        image: l.image,
        variantLabel: l.variantLabel,
        sku: '',
        unitPrice: l.unitPrice,
        qty: l.qty,
        lineTotal: l.lineTotal,
      })),
      subtotal: quote.subtotal,
      discount: quote.discount,
      shipping: quote.shipping,
      total: quote.total,
      shippingAddress: body.address,
      payment: {
        method: body.paymentMethod,
        status: body.paymentMethod === 'cod' ? 'unpaid' : 'pending_verification',
        senderPhone: body.senderPhone ?? '',
        trxId: body.trxId ? body.trxId.toUpperCase() : '',
        amount: quote.total,
      },
      status: 'pending',
      statusHistory: [{ status: 'pending', at: new Date(), by: null, note: 'Order placed' }],
      couponCode: quote.coupon?.code ?? '',
      note: body.note ?? '',
      idempotencyKey,
    });

    await audit(req, 'order.created', 'order', String(order._id), {
      orderNo: order.orderNo,
      total: order.total,
      method: order.payment.method,
    });
    res.status(201).json({ order });
  } catch (err) {
    await rollback().catch(() => undefined);
    // Concurrent duplicate with same idempotency key -> return the winner.
    if ((err as { code?: number }).code === 11000 && idempotencyKey) {
      const prior = await Order.findOne({ user: userId, idempotencyKey }).lean();
      if (prior) return res.status(200).json({ order: prior, idempotent: true });
    }
    throw err;
  }
}));

api.get('/orders', requireAuth, asyncRoute(async (req, res) => {
  const orders = await Order.find({ user: req.user!._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ orders });
}));

api.get('/orders/:id', requireAuth, asyncRoute(async (req, res) => {
  const order = isObjId(req.params.id)
    ? await Order.findById(req.params.id).lean()
    : await Order.findOne({ orderNo: String(req.params.id).toUpperCase() }).lean();
  if (!order) throw new ApiError(404, 'Order not found.', 'not_found');
  const isOwner = String(order.user) === String(req.user!._id);
  const isStaff = req.user!.role === 'admin' || req.user!.role === 'manager';
  if (!isOwner && !isStaff) throw new ApiError(404, 'Order not found.', 'not_found');
  res.json({ order });
}));

api.post('/orders/:id/cancel', writeLimiter, requireAuth, asyncRoute(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found.', 'not_found');
  if (String(order.user) !== String(req.user!._id)) throw new ApiError(404, 'Order not found.', 'not_found');
  if (!['pending', 'confirmed'].includes(order.status)) {
    throw new ApiError(409, 'This order can no longer be cancelled online. Please contact support.', 'cannot_cancel');
  }
  order.status = 'cancelled';
  order.statusHistory.push({ status: 'cancelled', at: new Date(), by: req.user!._id, note: 'Cancelled by customer' } as never);
  if (order.payment.status === 'paid') order.payment.status = 'refunded';
  await order.save();
  for (const item of order.items) {
    await Product.updateOne(
      { _id: item.product, 'variants._id': item.variantId },
      { $inc: { 'variants.$.stock': item.qty, sold: -item.qty } }
    );
  }
  await audit(req, 'order.cancelled_by_customer', 'order', String(order._id), { orderNo: order.orderNo });
  res.json({ order });
}));

api.post('/orders/track', orderLimiter, asyncRoute(async (req, res) => {
  const body = z.object({ orderNo: z.string().trim().min(4).max(30), phone: zPhone }).parse(req.body);
  const order = await Order.findOne({ orderNo: body.orderNo.toUpperCase() }).lean();
  const digits = order?.shippingAddress.phone.replace(/\D/g, '').slice(-11);
  if (!order || digits !== body.phone.replace(/\D/g, '').slice(-11)) {
    throw new ApiError(404, 'No order found with those details.', 'not_found');
  }
  res.json({
    order: {
      orderNo: order.orderNo,
      status: order.status,
      statusHistory: order.statusHistory,
      total: order.total,
      createdAt: order.createdAt,
    },
  });
}));

/* ==========================================================================
 * 13. ROUTES — CONTACT
 * ========================================================================== */

api.post('/contact', writeLimiter, asyncRoute(async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(80),
      email: zEmail,
      phone: z.string().trim().max(20).optional().default(''),
      subject: z.string().trim().max(140).optional().default(''),
      message: z.string().trim().min(10).max(2000),
    })
    .parse(req.body);
  await Message.create(body);
  res.status(201).json({ ok: true, message: 'Thanks! Our team will reply within 24 hours.' });
}));

/* ==========================================================================
 * 14. ROUTES — ADMIN / DASHBOARD
 * ========================================================================== */

api.get('/admin/stats', staffOnly, asyncRoute(async (_req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
  since.setHours(0, 0, 0, 0);

  const [totals, todayAgg, statusAgg, recent, lowStock, salesSeries, topProducts, pendingPayments, newCustomers] =
    await Promise.all([
      Order.aggregate([
        { $match: { status: { $nin: ['cancelled', 'returned'] } } },
        { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 }, items: { $sum: { $sum: '$items.qty' } } } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: startOfDay }, status: { $nin: ['cancelled', 'returned'] } } },
        { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),
      Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Order.find().sort({ createdAt: -1 }).limit(8).select('orderNo total status payment.status createdAt user').lean(),
      Product.aggregate([
        { $match: { isActive: true } },
        { $unwind: '$variants' },
        { $match: { 'variants.stock': { $lte: 3 } } },
        { $project: { name: 1, label: '$variants.label', stock: '$variants.stock' } },
        { $limit: 12 },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: since }, status: { $nin: ['cancelled', 'returned'] } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Dhaka' } },
            revenue: { $sum: '$total' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Product.find({ isActive: true }).sort({ sold: -1 }).limit(5).select('name sold images').lean(),
      Order.countDocuments({ 'payment.status': 'pending_verification' }),
      User.countDocuments({ role: 'customer', createdAt: { $gte: since } }),
    ]);

  const revenue = totals[0]?.revenue ?? 0;
  const orderCount = totals[0]?.orders ?? 0;
  res.json({
    revenue,
    orders: orderCount,
    itemsSold: totals[0]?.items ?? 0,
    averageOrderValue: orderCount ? Math.round(revenue / orderCount) : 0,
    today: { revenue: todayAgg[0]?.revenue ?? 0, orders: todayAgg[0]?.orders ?? 0 },
    statusBreakdown: statusAgg.map((s: { _id: string; count: number }) => ({ status: s._id, count: s.count })),
    recentOrders: recent,
    lowStock,
    salesSeries,
    topProducts,
    pendingPayments,
    newCustomers,
  });
}));

// Products
api.get('/admin/products', staffOnly, asyncRoute(async (req, res) => {
  const q = typeof req.query.q === 'string' ? clean(req.query.q).slice(0, 60) : '';
  const page = clampInt(req.query.page, 1, 1, 10_000);
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const filter: Record<string, unknown> = {};
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' };
  if (req.query.category && isObjId(req.query.category)) filter.category = req.query.category;
  if (req.query.active === '1') filter.isActive = true;
  if (req.query.active === '0') filter.isActive = false;

  const [total, products, categories] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Category.find().sort({ sortOrder: 1 }).lean(),
  ]);
  const catMap = new Map<string, string>(categories.map((c: any) => [String(c._id), String(c.name)]));
  res.json({
    products: products.map((p: any) => productCard(p, catMap.get(String(p.category)))),
    categories,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  });
}));

api.post('/admin/products', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  const body = productInput.parse(req.body);
  if (!(await Category.exists({ _id: body.category }))) throw new ApiError(400, 'Category not found.', 'bad_category');
  const baseSlug = slugify(body.slug || body.name) || `product-${Date.now()}`;
  let slug = baseSlug;
  for (let i = 2; await Product.exists({ slug }); i += 1) slug = `${baseSlug}-${i}`;
  const product = await Product.create({ ...body, slug });
  await audit(req, 'product.created', 'product', String(product._id), { name: product.name });
  res.status(201).json({ product });
}));

api.patch('/admin/products/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid product id.', 'bad_request');
  const body = productInput.partial().parse(req.body);
  if (body.category && !(await Category.exists({ _id: body.category }))) {
    throw new ApiError(400, 'Category not found.', 'bad_category');
  }
  const update: Record<string, unknown> = { ...body };
  if (body.slug) update.slug = slugify(body.slug);
  else delete update.slug;
  const product = await Product.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
  if (!product) throw new ApiError(404, 'Product not found.', 'not_found');
  await audit(req, 'product.updated', 'product', String(product._id), { fields: Object.keys(update) });
  res.json({ product });
}));

api.delete('/admin/products/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid product id.', 'bad_request');
  // Soft delete keeps historical orders intact.
  const product = await Product.findByIdAndUpdate(req.params.id, { $set: { isActive: false, isFeatured: false } }, { new: true });
  if (!product) throw new ApiError(404, 'Product not found.', 'not_found');
  await audit(req, 'product.archived', 'product', String(product._id));
  res.json({ ok: true });
}));

// Categories
api.get('/admin/categories', staffOnly, asyncRoute(async (_req, res) => {
  const categories = await Category.find().sort({ sortOrder: 1, name: 1 }).lean();
  res.json({ categories });
}));

api.post('/admin/categories', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(60),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(300).optional().default(''),
      image: z.string().trim().max(600).optional().default(''),
      sortOrder: z.number().int().min(0).max(999).optional().default(0),
      isActive: z.boolean().optional().default(true),
    })
    .parse(req.body);
  const slug = slugify(body.slug || body.name);
  if (await Category.exists({ slug })) throw new ApiError(409, 'A category with this slug already exists.', 'duplicate');
  const category = await Category.create({ ...body, slug });
  await audit(req, 'category.created', 'category', String(category._id), { name: category.name });
  res.status(201).json({ category });
}));

api.patch('/admin/categories/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid category id.', 'bad_request');
  const body = z
    .object({
      name: z.string().trim().min(2).max(60).optional(),
      slug: z.string().trim().max(80).optional(),
      description: z.string().trim().max(300).optional(),
      image: z.string().trim().max(600).optional(),
      sortOrder: z.number().int().min(0).max(999).optional(),
      isActive: z.boolean().optional(),
    })
    .parse(req.body);
  const update: Record<string, unknown> = { ...body };
  if (body.slug) update.slug = slugify(body.slug);
  const category = await Category.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!category) throw new ApiError(404, 'Category not found.', 'not_found');
  await audit(req, 'category.updated', 'category', String(category._id));
  res.json({ category });
}));

api.delete('/admin/categories/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid category id.', 'bad_request');
  const inUse = await Product.countDocuments({ category: req.params.id, isActive: true });
  if (inUse > 0) throw new ApiError(409, `Move the ${inUse} product(s) in this category first.`, 'category_in_use');
  await Category.deleteOne({ _id: req.params.id });
  await audit(req, 'category.deleted', 'category', String(req.params.id));
  res.json({ ok: true });
}));

// Orders
api.get('/admin/orders', staffOnly, asyncRoute(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 10_000);
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === 'string' && ORDER_STATUSES.includes(req.query.status as OrderStatus)) {
    filter.status = req.query.status;
  }
  if (typeof req.query.payment === 'string' && PAYMENT_STATUSES.includes(req.query.payment as never)) {
    filter['payment.status'] = req.query.payment;
  }
  if (typeof req.query.q === 'string' && req.query.q.trim()) {
    const q = clean(req.query.q).slice(0, 40);
    filter.$or = [
      { orderNo: { $regex: escapeRegex(q), $options: 'i' } },
      { 'shippingAddress.name': { $regex: escapeRegex(q), $options: 'i' } },
      { 'shippingAddress.phone': { $regex: escapeRegex(q) } },
    ];
  }
  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  res.json({ orders, total, page, pages: Math.ceil(total / limit) || 1 });
}));

api.get('/admin/orders/:id', staffOnly, asyncRoute(async (req, res) => {
  const order = isObjId(req.params.id)
    ? await Order.findById(req.params.id).lean()
    : await Order.findOne({ orderNo: String(req.params.id).toUpperCase() }).lean();
  if (!order) throw new ApiError(404, 'Order not found.', 'not_found');
  const customer = await User.findById(order.user).select('name email phone createdAt').lean();
  res.json({ order, customer });
}));

api.patch('/admin/orders/:id/status', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid order id.', 'bad_request');
  const body = z
    .object({ status: z.enum(ORDER_STATUSES), note: z.string().trim().max(300).optional().default('') })
    .parse(req.body);
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found.', 'not_found');
  const current = order.status as OrderStatus;
  if (!STATUS_TRANSITIONS[current].includes(body.status)) {
    throw new ApiError(409, `Cannot move an order from ${current} to ${body.status}.`, 'bad_transition');
  }
  if (body.status === 'cancelled' || body.status === 'returned') {
    for (const item of order.items) {
      await Product.updateOne(
        { _id: item.product, 'variants._id': item.variantId },
        { $inc: { 'variants.$.stock': item.qty, sold: -item.qty } }
      );
    }
    if (order.payment.status === 'paid') order.payment.status = 'refunded';
  }
  if (body.status === 'delivered' && order.payment.method === 'cod' && order.payment.status === 'unpaid') {
    order.payment.status = 'paid';
    order.payment.verifiedBy = req.user!._id;
    order.payment.verifiedAt = new Date();
    order.payment.note = 'Collected on delivery';
  }
  order.status = body.status;
  order.statusHistory.push({ status: body.status, at: new Date(), by: req.user!._id, note: body.note } as never);
  await order.save();
  await audit(req, 'order.status_changed', 'order', String(order._id), { from: current, to: body.status });
  res.json({ order });
}));

api.patch('/admin/orders/:id/payment', writeLimiter, adminOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid order id.', 'bad_request');
  const body = z
    .object({
      status: z.enum(['unpaid', 'pending_verification', 'paid', 'failed', 'refunded']),
      note: z.string().trim().max(300).optional().default(''),
    })
    .parse(req.body);
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found.', 'not_found');
  const previous = order.payment.status;
  if (previous === 'refunded' && body.status !== 'refunded') {
    throw new ApiError(409, 'A refunded payment cannot be reopened.', 'bad_transition');
  }
  order.payment.status = body.status;
  order.payment.note = body.note;
  if (body.status === 'paid') {
    order.payment.verifiedBy = req.user!._id;
    order.payment.verifiedAt = new Date();
  }
  await order.save();
  await audit(req, 'order.payment_changed', 'order', String(order._id), { from: previous, to: body.status, amount: order.total });
  res.json({ order });
}));

api.patch('/admin/orders/:id/note', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  const body = z.object({ adminNote: z.string().trim().max(400) }).parse(req.body);
  const order = await Order.findByIdAndUpdate(req.params.id, { $set: { adminNote: body.adminNote } }, { new: true });
  if (!order) throw new ApiError(404, 'Order not found.', 'not_found');
  res.json({ order });
}));

// Customers
api.get('/admin/customers', staffOnly, asyncRoute(async (req, res) => {
  const q = typeof req.query.q === 'string' ? clean(req.query.q).slice(0, 60) : '';
  const filter: Record<string, unknown> = { role: { $in: ['customer'] } };
  if (q) {
    filter.$or = [
      { name: { $regex: escapeRegex(q), $options: 'i' } },
      { email: { $regex: escapeRegex(q), $options: 'i' } },
      { phone: { $regex: escapeRegex(q) } },
    ];
  }
  const customers = await User.find(filter).select('name email phone role isActive createdAt lastLoginAt').sort({ createdAt: -1 }).limit(100).lean();
  const spend = await Order.aggregate([
    { $match: { status: { $nin: ['cancelled', 'returned'] } } },
    { $group: { _id: '$user', total: { $sum: '$total' }, orders: { $sum: 1 } } },
  ]);
  const spendMap = new Map<string, { total?: number; orders?: number }>(
    spend.map((s: { _id: unknown; total: number; orders: number }) => [String(s._id), s] as [string, { total?: number; orders?: number }])
  );
  res.json({
    customers: customers.map((c: any) => ({
      ...c,
      id: String(c._id),
      totalSpent: spendMap.get(String(c._id))?.total ?? 0,
      orderCount: spendMap.get(String(c._id))?.orders ?? 0,
    })),
  });
}));

api.patch('/admin/customers/:id', writeLimiter, adminOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid customer id.', 'bad_request');
  const body = z.object({ isActive: z.boolean().optional(), role: z.enum(['customer', 'manager', 'admin']).optional() }).parse(req.body);
  if (String(req.params.id) === String(req.user!._id) && body.role && body.role !== 'admin') {
    throw new ApiError(400, 'You cannot demote your own account.', 'self_demote');
  }
  const update: Record<string, unknown> = { ...body };
  if (body.isActive === false) update.tokenVersion = (await User.findById(req.params.id).select('tokenVersion').lean() as any)?.tokenVersion + 1;
  const user = await User.findByIdAndUpdate(req.params.id, { $set: update, ...(body.isActive === false ? { $inc: { tokenVersion: 1 } } : {}) }, { new: true });
  if (!user) throw new ApiError(404, 'Customer not found.', 'not_found');
  await audit(req, 'customer.updated', 'user', String(user._id), { fields: Object.keys(body) });
  res.json({ user: publicUser(user) });
}));

// Coupons
api.get('/admin/coupons', staffOnly, asyncRoute(async (_req, res) => {
  res.json({ coupons: await Coupon.find().sort({ createdAt: -1 }).lean() });
}));

api.post('/admin/coupons', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  const body = couponInput.parse(req.body);
  const exists = await Coupon.exists({ code: body.code.toUpperCase() });
  if (exists) throw new ApiError(409, 'That coupon code already exists.', 'duplicate');
  const coupon = await Coupon.create({
    ...body,
    code: body.code.toUpperCase(),
    value: body.type === 'percent' ? Math.min(body.value, 90) : body.value,
    startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
  });
  await audit(req, 'coupon.created', 'coupon', String(coupon._id), { code: coupon.code });
  res.status(201).json({ coupon });
}));

api.patch('/admin/coupons/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid coupon id.', 'bad_request');
  const body = couponInput.partial().parse(req.body);
  const update: Record<string, unknown> = { ...body };
  if (body.code) update.code = body.code.toUpperCase();
  if (body.startsAt) update.startsAt = new Date(body.startsAt);
  if (body.expiresAt) update.expiresAt = new Date(body.expiresAt);
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!coupon) throw new ApiError(404, 'Coupon not found.', 'not_found');
  await audit(req, 'coupon.updated', 'coupon', String(coupon._id));
  res.json({ coupon });
}));

api.delete('/admin/coupons/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid coupon id.', 'bad_request');
  await Coupon.deleteOne({ _id: req.params.id });
  await audit(req, 'coupon.deleted', 'coupon', String(req.params.id));
  res.json({ ok: true });
}));

// Reviews
api.get('/admin/reviews', staffOnly, asyncRoute(async (req, res) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === 'string' && ['pending', 'approved', 'rejected'].includes(req.query.status)) {
    filter.status = req.query.status;
  }
  const reviews = await Review.find(filter).sort({ createdAt: -1 }).limit(100).populate('product', 'name slug').lean();
  res.json({ reviews });
}));

api.patch('/admin/reviews/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid review id.', 'bad_request');
  const body = z.object({ status: z.enum(['pending', 'approved', 'rejected']) }).parse(req.body);
  const review = await Review.findByIdAndUpdate(req.params.id, { $set: { status: body.status } }, { new: true });
  if (!review) throw new ApiError(404, 'Review not found.', 'not_found');
  const agg = await Review.aggregate([
    { $match: { product: review.product, status: 'approved' } },
    { $group: { _id: '$product', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.updateOne(
    { _id: review.product },
    { $set: { ratingAvg: Math.round((agg[0]?.avg ?? 0) * 10) / 10, ratingCount: agg[0]?.count ?? 0 } }
  );
  await audit(req, 'review.moderated', 'review', String(review._id), { status: body.status });
  res.json({ review });
}));

api.delete('/admin/reviews/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  if (!isObjId(req.params.id)) throw new ApiError(400, 'Invalid review id.', 'bad_request');
  await Review.deleteOne({ _id: req.params.id });
  await audit(req, 'review.deleted', 'review', String(req.params.id));
  res.json({ ok: true });
}));

// Messages
api.get('/admin/messages', staffOnly, asyncRoute(async (_req, res) => {
  res.json({ messages: await Message.find().sort({ createdAt: -1 }).limit(100).lean() });
}));

api.patch('/admin/messages/:id', writeLimiter, staffOnly, asyncRoute(async (req, res) => {
  const body = z.object({ isRead: z.boolean() }).parse(req.body);
  const message = await Message.findByIdAndUpdate(req.params.id, { $set: body }, { new: true });
  if (!message) throw new ApiError(404, 'Message not found.', 'not_found');
  res.json({ message });
}));

// Settings
api.get('/admin/settings', staffOnly, asyncRoute(async (_req, res) => {
  const settings = await getSettings();
  const cover = await Asset.findOne({ key: 'support-cover' }).select('updatedAt').lean();
  res.json({
    settings: {
      ...settings.toObject(),
      supportCover: cover ? `/api/support-cover?v=${new Date((cover as { updatedAt: Date }).updatedAt).getTime()}` : '',
    },
  });
}));

api.put('/admin/settings', writeLimiter, adminOnly, asyncRoute(async (req, res) => {
  const body = z
    .object({
      storeName: z.string().trim().min(2).max(80).optional(),
      tagline: z.string().trim().max(160).optional(),
      announcement: z.string().trim().max(200).optional(),
      phone: z.string().trim().max(30).optional(),
      email: z.string().trim().max(120).optional(),
      address: z.string().trim().max(200).optional(),
      facebook: z.string().trim().max(200).optional(),
      instagram: z.string().trim().max(200).optional(),
      whatsapp: z.string().trim().max(200).optional(),
      freeShippingThreshold: z.number().int().min(0).max(100_000_000).optional(),
      codEnabled: z.boolean().optional(),
      walletEnabled: z.boolean().optional(),
      bkashNumber: z.string().trim().max(30).optional(),
      nagadNumber: z.string().trim().max(30).optional(),
      rocketNumber: z.string().trim().max(30).optional(),
      shippingZones: z.array(z.object({ district: z.string().trim().min(2).max(80), charge: z.number().int().min(0).max(1_000_000) })).max(80).optional(),
      defaultShippingCharge: z.number().int().min(0).max(1_000_000).optional(),
      returnPolicy: z.string().trim().max(500).optional(),
      supportWhatsapp: z.string().trim().max(200).optional(),
      supportMessenger: z.string().trim().max(200).optional(),
      supportEmail: z.string().trim().max(120).optional(),
    })
    .parse(req.body);
  const settings = await Settings.findOneAndUpdate({ key: 'site' }, { $set: body }, { new: true, upsert: true });
  await audit(req, 'settings.updated', 'settings', 'site', { fields: Object.keys(body) });
  res.json({ settings });
}));

/* Support-center cover upload. Two ways in, both stored in Mongo and served
 * from /api/support-cover: a raw image body from the admin's computer, or a
 * remote link the server downloads once (so the shop never hotlinks). */
function assertPublicHttpUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (!/^https?:$/.test(parsed.protocol)) throw new ApiError(400, 'Only http(s) links are supported.', 'bad_url');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^(127\.|10\.|169\.254\.|0\.|192\.168\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) throw new ApiError(400, 'That link points to a private address.', 'bad_url');
  return parsed;
}

api.post(
  '/admin/support-cover',
  writeLimiter,
  adminOnly,
  express.raw({ type: IMAGE_TYPES, limit: '4mb' }),
  asyncRoute(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    const contentType = (req.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!buffer?.length) throw new ApiError(400, 'Send the image as the raw request body.', 'bad_image');
    if (!IMAGE_TYPES.includes(contentType)) throw new ApiError(400, 'Use a JPEG, PNG, WebP or GIF image.', 'bad_image');
    if (buffer.length > SUPPORT_COVER_MAX) throw new ApiError(413, 'That image is larger than 4 MB.', 'too_large');
    await Asset.updateOne(
      { key: 'support-cover' },
      { $set: { contentType, size: buffer.length, data: buffer, updatedAt: new Date() } },
      { upsert: true }
    );
    await audit(req, 'support.cover_uploaded', 'settings', 'support-cover', { size: buffer.length, contentType });
    res.json({ url: `/api/support-cover?v=${Date.now()}` });
  })
);

api.post(
  '/admin/images',
  writeLimiter,
  staffOnly,
  express.raw({ type: IMAGE_TYPES, limit: '4mb' }),
  asyncRoute(async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    const contentType = (req.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!buffer?.length) throw new ApiError(400, 'Send the image as the raw request body.', 'bad_image');
    if (!IMAGE_TYPES.includes(contentType)) throw new ApiError(400, 'Use a JPEG, PNG, WebP or GIF image.', 'bad_image');
    if (buffer.length > SUPPORT_COVER_MAX) throw new ApiError(413, 'That image is larger than 4 MB.', 'too_large');
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await Asset.create({ key, contentType, size: buffer.length, data: buffer, updatedAt: new Date() });
    await audit(req, 'image.uploaded', 'asset', key, { size: buffer.length, contentType });
    res.status(201).json({ url: `/api/asset/${key}`, key });
  })
);

api.post('/admin/support-cover/url', writeLimiter, adminOnly, asyncRoute(async (req, res) => {
  const { url } = z.object({ url: z.string().trim().min(8).max(1000) }).parse(req.body);
  const target = assertPublicHttpUrl(url);
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new ApiError(400, 'Could not download that image. Check the link and try again.', 'fetch_failed');
  }
  if (!upstream.ok) throw new ApiError(400, `That link returned ${upstream.status}.`, 'fetch_failed');
  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!IMAGE_TYPES.includes(contentType)) throw new ApiError(400, 'That link is not a JPEG, PNG, WebP or GIF image.', 'bad_image');
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (!buffer.length) throw new ApiError(400, 'That link returned an empty file.', 'bad_image');
  if (buffer.length > SUPPORT_COVER_MAX) throw new ApiError(413, 'That image is larger than 4 MB.', 'too_large');
  await Asset.updateOne(
    { key: 'support-cover' },
    { $set: { contentType, size: buffer.length, data: buffer, updatedAt: new Date() } },
    { upsert: true }
  );
  await audit(req, 'support.cover_imported', 'settings', 'support-cover', { size: buffer.length, contentType });
  res.json({ url: `/api/support-cover?v=${Date.now()}` });
}));

api.delete('/admin/support-cover', writeLimiter, adminOnly, asyncRoute(async (req, res) => {
  await Asset.deleteOne({ key: 'support-cover' });
  await audit(req, 'support.cover_removed', 'settings', 'support-cover', {});
  res.json({ ok: true });
}));

// Audit trail
api.get('/admin/audit', adminOnly, asyncRoute(async (_req, res) => {
  const logs = await Audit.find().sort({ at: -1 }).limit(200).lean();
  res.json({ logs });
}));

app.use('/api', api);

/* ==========================================================================
 * 15. ADMIN DASHBOARD (static build) + ERRORS
 * --------------------------------------------------------------------------
 * The customer storefront is a separate project (../frontend) and is deployed
 * on its own. This server only hosts the staff dashboard, at /admin, from
 * admin/dist — so customer traffic never reaches admin code and vice versa.
 * ========================================================================== */

const ADMIN_DIR = process.env.ADMIN_DIR ?? path.join(process.cwd(), 'admin', 'dist');
const ADMIN_INDEX = path.join(ADMIN_DIR, 'index.html');

if (fs.existsSync(ADMIN_INDEX)) {
  app.use(
    '/admin',
    express.static(ADMIN_DIR, {
      index: false,
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      },
    })
  );
  // SPA fallback for dashboard deep links.
  app.get(['/admin', '/admin/*'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(ADMIN_INDEX);
  });
} else {
  app.get(['/admin', '/admin/*'], (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('Dashboard build not found. Run: npm run build -w backend/admin');
  });
}

// Small landing response so hitting the API root is not a confusing 404.
app.get('/', (_req, res) => {
  res.json({
    service: 'nivora-api',
    health: '/api/health',
    dashboard: fs.existsSync(ADMIN_INDEX) ? '/admin' : 'not built (npm run build -w backend/admin)',
    storefront: 'separate app (see ../frontend)',
  });
});

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Endpoint not found.', 'not_found')));

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details ?? undefined, requestId: req.requestId });
  }
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: err.issues[0]?.message ?? 'Invalid request.',
      code: 'validation',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      requestId: req.requestId,
    });
  }
  const anyErr = err as { type?: string; code?: number; status?: number; message?: string };
  if (anyErr?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.', code: 'bad_json', requestId: req.requestId });
  }
  if (anyErr?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.', code: 'too_large', requestId: req.requestId });
  }
  if (anyErr?.code === 11000) {
    return res.status(409).json({ error: 'That record already exists.', code: 'duplicate', requestId: req.requestId });
  }
  console.error(`[error] ${req.requestId}`, err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.', code: 'server_error', requestId: req.requestId });
});

/* ==========================================================================
 * 16. SEED + BOOT
 * ========================================================================== */

const IMG = (seed: string) => `/api/img/${seed}`;

const SEED_CATEGORIES = [
  { name: 'Kurti Set', slug: 'kurti-set', description: 'Two and three piece kurti sets.', sortOrder: 1, image: IMG('cat-kurti-set') },
  { name: 'Farsi Set', slug: 'farsi-set', description: 'Elegant farsi sets for every occasion.', sortOrder: 2, image: IMG('cat-farsi-set') },
  { name: 'Corset', slug: 'corset', description: 'Structured corsets to complete the look.', sortOrder: 3, image: IMG('cat-corset') },
];

const SEED_PRODUCTS = [
  { name: 'SIARA ~ Fuchsia', slug: 'siara-fuchsia', cat: 'kurti-set', base: 99900, high: 199900, colors: 'fuchsia', featured: true },
  { name: 'SIARA ~ Midnight Cranberry', slug: 'siara-midnight-cranberry', cat: 'kurti-set', base: 99900, high: 199900, colors: 'cranberry', featured: false },
  { name: 'SIARA ~ Ocean Teal', slug: 'siara-ocean-teal', cat: 'kurti-set', base: 99900, high: 199900, colors: 'teal', featured: true },
  { name: 'ESHAL – Butter Yellow', slug: 'eshal-butter-yellow', cat: 'kurti-set', base: 89900, high: 179900, colors: 'butter', featured: false },
  { name: 'ESHAL – Lavender', slug: 'eshal-lavender', cat: 'kurti-set', base: 89900, high: 179900, colors: 'lavender', featured: true },
  { name: 'ESHAL – Dusty Rose', slug: 'eshal-dusty-rose', cat: 'kurti-set', base: 89900, high: 179900, colors: 'rose', featured: false },
  { name: 'ESHAL – Rosy', slug: 'eshal-rosy', cat: 'kurti-set', base: 89900, high: 179900, colors: 'rosy', featured: false },
  { name: 'ESHAL – Cocoa', slug: 'eshal-cocoa', cat: 'kurti-set', base: 99900, high: 179900, colors: 'cocoa', featured: false },
  { name: '~ SANAAM ~ Butter Yellow', slug: 'sanaam-butter-yellow', cat: 'farsi-set', base: 159900, high: 0, colors: 'sanaam1', featured: true },
  { name: '~ SANAAM ~ Blush Peach', slug: 'sanaam-blush-peach', cat: 'farsi-set', base: 159900, high: 0, colors: 'sanaam2', featured: false },
  { name: '~ SANAAM ~ Matcha Leaf', slug: 'sanaam-matcha-leaf', cat: 'farsi-set', base: 159900, high: 0, colors: 'sanaam3', featured: false },
  { name: 'Raspberry Corset', slug: 'raspberry-corset', cat: 'corset', base: 75000, high: 149900, colors: 'raspberry', featured: false },
  { name: 'Sukuun Corset', slug: 'sukuun-corset', cat: 'corset', base: 75000, high: 149900, colors: 'sukuun', featured: true },
  { name: 'Lilac Corset', slug: 'lilac-corset', cat: 'corset', base: 75000, high: 149900, colors: 'lilac', featured: false },
  { name: 'Sapphire Corset', slug: 'sapphire-corset', cat: 'corset', base: 75000, high: 149900, colors: 'sapphire', featured: false },
  { name: 'Pistachio Corset', slug: 'pistachio-corset', cat: 'corset', base: 75000, high: 149900, colors: 'pistachio', featured: false },
  { name: 'Wine Rose Corset', slug: 'wine-rose-corset', cat: 'corset', base: 75000, high: 149900, colors: 'winerose', featured: false },
  { name: 'Mulberry Corset', slug: 'mulberry-corset', cat: 'corset', base: 75000, high: 149900, colors: 'mulberry', featured: false },
];

async function seed(force = false) {
  const userCount = await User.countDocuments();
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@nivora.local').toLowerCase();
  if (!userCount || force) {
    const password = process.env.ADMIN_PASSWORD ?? 'Admin@12345678';
    if (!process.env.ADMIN_PASSWORD) {
      console.warn(`[seed] ADMIN_PASSWORD not set — creating admin with the default password "${password}". Change it immediately.`);
    }
    await User.updateOne(
      { email: adminEmail },
      {
        $setOnInsert: {
          name: 'Store Admin',
          email: adminEmail,
          phone: '01700000000',
          passwordHash: await bcrypt.hash(password, BCRYPT_COST),
          role: 'admin',
        },
      },
      { upsert: true }
    );
  }

  await getSettings();

  if ((await Category.countDocuments()) === 0) {
    await Category.insertMany(SEED_CATEGORIES);
    console.log('[seed] categories created');
  }

  if ((await Product.countDocuments()) === 0) {
    const cats = await Category.find().lean();
    const catMap = new Map(cats.map((c: any) => [c.slug, c._id]));
    const docs = SEED_PRODUCTS.map((p, index) => ({
      name: p.name,
      slug: p.slug,
      description:
        'Premium fabric, carefully finished and ready for everyday wear. Every piece is quality checked before dispatch, with nationwide delivery in 3-5 days and easy 7 day returns.',
      category: catMap.get(p.cat),
      images: [{ url: IMG(p.colors), alt: p.name }, { url: IMG(`${p.colors}-b`), alt: p.name }],
      variants: p.high
        ? [
            { label: p.cat === 'corset' ? 'Regular' : 'Kurti Only', price: p.base, compareAtPrice: Math.round((p.base * 1.3) / 100) * 100, stock: index % 7 === 5 ? 0 : 12 },
            { label: p.cat === 'corset' ? 'Premium' : 'Kurti + Palazzo', price: p.high, compareAtPrice: Math.round((p.high * 1.25) / 100) * 100, stock: index % 5 === 3 ? 0 : 8 },
          ]
        : [{ label: 'Full Set', price: p.base, compareAtPrice: Math.round((p.base * 1.2) / 100) * 100, stock: 10 }],
      isFeatured: p.featured,
      tags: [p.cat, 'new'],
    }));
    await Product.insertMany(docs);
    console.log(`[seed] ${docs.length} products created`);
  }
}

export async function connectDatabase() {
  let uri = process.env.MONGODB_URI;
  if (DB_MEMORY) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mem = await MongoMemoryServer.create({ instance: { dbName: 'nivora' } });
    uri = mem.getUri();
    console.log('[db] in-memory MongoDB started (development only)');
  }
  if (!uri) {
    console.error('[fatal] MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  mongoose.set('strictQuery', true);
  mongoose.set('runValidators', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });
  console.log('[db] connected');
}

/** Connect once per serverless instance and reuse the pool across invocations. */
let dbPromise: Promise<void> | null = null;
export function ensureDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!dbPromise) {
    dbPromise = connectDatabase().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function main() {
  await connectDatabase();
  await seed(process.env.SEED === '1');
  if (process.env.SEED === '1') {
    console.log('[seed] done');
    await mongoose.disconnect();
    process.exit(0);
  }
  app.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT} (${NODE_ENV})`);
    console.log(`[api] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
}

// On Vercel the app is exported as a serverless handler (see api/[...path].ts)
// and the platform owns the HTTP server, so nothing may listen there.
if (process.env.VERCEL !== '1') {
  main().catch((err) => {
    console.error('[fatal] boot failed', err);
    process.exit(1);
  });
}

process.on('SIGTERM', async () => {
  console.log('[api] shutting down');
  await mongoose.connection.close();
  process.exit(0);
});

export { app };
