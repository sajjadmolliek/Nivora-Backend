/* =============================================================================
 * NIVORA — ADMIN DASHBOARD (staff-only app, served by the backend)
 * -----------------------------------------------------------------------------
 * Lives inside the backend project because only staff deploy/use it. It ships
 * as a static bundle the API serves at /admin. Customers never load this code:
 * the storefront is a completely separate app in ../../../frontend.
 *
 * Every route is behind <Protected staff>, and the API enforces the same rule
 * server-side (RBAC), so hiding the UI alone is never the security boundary.
 * ========================================================================== */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import './styles.css';

/* =============================================================================
 * 1. TYPES
 * ========================================================================== */

interface Settings {
  storeName: string;
  tagline: string;
  announcement: string;
  phone: string;
  email: string;
  address: string;
  facebook: string;
  instagram: string;
  whatsapp: string;
  freeShippingThreshold: number;
  codEnabled: boolean;
  walletEnabled: boolean;
  bkashNumber: string;
  nagadNumber: string;
  rocketNumber: string;
  shippingZones: { district: string; charge: number }[];
  defaultShippingCharge: number;
  returnPolicy: string;
  supportWhatsapp: string;
  supportMessenger: string;
  supportEmail: string;
  supportCover: string;
}

interface Image {
  url: string;
  alt?: string;
}

interface Variant {
  _id: string;
  label: string;
  sku?: string;
  price: number;
  compareAtPrice: number;
  stock: number;
}

interface Product {
  id: string;
  _id?: string;
  name: string;
  slug: string;
  description: string;
  category: string | null;
  categoryId: string;
  images: Image[];
  priceMin: number;
  priceMax: number;
  compareAtPrice: number;
  inStock: boolean;
  variants: Variant[];
  isFeatured: boolean;
  ratingAvg: number;
  ratingCount: number;
  sold: number;
  tags: string[];
  createdAt: string;
  isActive?: boolean;
}

interface Category {
  id?: string;
  _id?: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  sortOrder?: number;
  isActive?: boolean;
  productCount?: number;
}

interface Address {
  _id?: string;
  label?: string;
  name: string;
  phone: string;
  area: string;
  city: string;
  district: string;
  postcode?: string;
  address: string;
  isDefault?: boolean;
}

interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'customer' | 'manager' | 'admin';
  addresses: Address[];
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
  currency: string;
}

interface OrderItem {
  product: string;
  variantId: string;
  name: string;
  slug: string;
  image: string;
  variantLabel: string;
  unitPrice: number;
  qty: number;
  lineTotal: number;
}

interface Order {
  _id: string;
  orderNo: string;
  user: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  shippingAddress: Address;
  payment: {
    method: 'cod' | 'bkash' | 'nagad' | 'rocket';
    status: 'unpaid' | 'pending_verification' | 'paid' | 'failed' | 'refunded';
    senderPhone?: string;
    trxId?: string;
    amount?: number;
    note?: string;
    verifiedAt?: string;
  };
  status: OrderStatus;
  statusHistory: { status: string; at: string; note?: string }[];
  couponCode: string;
  note: string;
  adminNote?: string;
  createdAt: string;
  updatedAt: string;
}

type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'returned';

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

/* =============================================================================
 * 2. UTILITIES
 * ========================================================================== */

const taka = (poisha: number): string =>
  '৳' +
  (poisha / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

const toPoisha = (takaValue: string | number): number => {
  const n = typeof takaValue === 'number' ? takaValue : parseFloat(takaValue);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const fromPoisha = (poisha: number): string => String(Math.round(poisha) / 100);

const dateShort = (iso?: string): string =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const dateTime = (iso?: string): string =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const initials = (name: string): string =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function readCookie(name: string): string {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

/**
 * Downscale + re-encode in the browser before uploading, so a phone photo
 * becomes a small, web-friendly banner instead of a 6 MB original.
 */
async function shrinkImage(file: File, maxWidth = 1600): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPEG, PNG, WebP or GIF).');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image.');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Could not process that image.');
  return blob;
}

/** Upload a picture chosen from this device; the API stores the bytes. */
async function uploadImageFile(file: File, maxWidth = 1600): Promise<string> {
  const blob = await shrinkImage(file, maxWidth);
  const token = await csrfToken();
  const res = await fetch(apiUrl('/admin/images'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-csrf-token': token },
    body: blob,
  });
  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!res.ok || !data?.url) throw new Error(data?.error ?? 'Could not upload that image.');
  return data.url;
}

/* =============================================================================
 * 3. API CLIENT — cookies + CSRF double-submit + silent refresh
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

const CSRF_COOKIE = 'bl_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Same-origin by default (dev proxies /api here). Set VITE_API_URL otherwise. */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
const apiUrl = (p: string): string => `${API_BASE}/api${p}`;
/** Resolve server-relative asset paths (e.g. /api/img/…). */
const assetUrl = (url: string): string =>
  !url || !API_BASE || /^https?:\/\//i.test(url) ? url : `${API_BASE}${url}`;
/** Public storefront (separate app) so staff can jump back to the shop. */
const STORE_URL = import.meta.env.VITE_STORE_URL ?? 'http://localhost:5001';

async function csrfToken(): Promise<string> {
  let token = readCookie(CSRF_COOKIE);
  if (!token) {
    await fetch(apiUrl('/auth/csrf'), { credentials: 'include' }).catch(() => undefined);
    token = readCookie(CSRF_COOKIE);
  }
  return token;
}

let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const token = await csrfToken();
        const res = await fetch(apiUrl('/auth/refresh'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
          body: '{}',
        });
        return res.ok;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

interface ReqOptions {
  body?: unknown;
  idempotencyKey?: string;
}

async function request<T>(method: string, path: string, opts: ReqOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) headers['x-csrf-token'] = await csrfToken();
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'include',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  let data: Record<string, unknown> | null = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }

  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refreshSession()) return request<T>(method, path, opts, true);
  }

  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`;
    const code = typeof data?.code === 'string' ? data.code : 'error';
    throw new ApiError(res.status, message, code, data?.warnings ?? data?.details);
  }
  return (data ?? {}) as T;
}

const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>('POST', path, { body: body ?? {}, idempotencyKey }),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  put: <T,>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  del: <T,>(path: string) => request<T>('DELETE', path),
};

/* =============================================================================
 * 4. CONTEXTS — toasts, settings, auth, cart
 * ========================================================================== */

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

const ToastCtx = createContext<{ notify: (message: string, tone?: Toast['tone']) => void }>({
  notify: () => undefined,
});
const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((cur) => [...cur.slice(-3), { id, message, tone }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 4200);
  }, []);
  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.tone}`)}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

const SettingsCtx = createContext<Settings | null>(null);
const useSettings = (): Settings => {
  const s = useContext(SettingsCtx);
  if (!s) throw new Error('Settings not loaded');
  return s;
};

function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api
      .get<{ settings: Settings }>('/settings')
      .then((r) => setSettings(r.settings))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (settings) document.title = `${settings.storeName} — ${settings.tagline}`;
  }, [settings]);
  if (!settings) {
    return (
      <div className="boot">
        <img className="boot-logo" src={`${import.meta.env.BASE_URL}brand/nivora-logo.png`} alt="Nivora" />
        <p>{failed ? 'We could not reach the store. Please refresh in a moment.' : 'Loading…'}</p>
      </div>
    );
  }
  return <SettingsCtx.Provider value={settings}>{children}</SettingsCtx.Provider>;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User | null) => void;
}
const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => undefined,
  logout: async () => undefined,
  setUser: () => undefined,
});
const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { notify } = useToast();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: User | null }>('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
      notify('You have been signed out.', 'info');
    }
  }, [notify]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, refresh, logout, setUser }),
    [user, loading, refresh, logout]
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/* =============================================================================
 * 5. UI PRIMITIVES
 * ========================================================================== */

function Button({
  children,
  variant = 'primary',
  size,
  loading,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle';
  size?: 'sm' | 'lg';
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)}
    >
      {loading ? <span className="spinner" aria-hidden /> : children}
    </button>
  );
}

function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('field', className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function Badge({ status }: { status: string }) {
  return <span className={cx('badge', `badge-${status.replace(/\s+/g, '-')}`)}>{title(status.replace(/_/g, ' '))}</span>;
}

function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <span className="spinner dark" />
      <span>{label}</span>
    </div>
  );
}

function Empty({ title: heading, text, action }: { title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{heading}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

function Stars({ rating, count }: { rating: number; count?: number }) {
  const full = Math.round(rating);
  return (
    <span className="stars" aria-label={`${rating.toFixed(1)} out of 5`}>
      {'★★★★★'.slice(0, full)}
      <span className="stars-empty">{'★★★★★'.slice(full)}</span>
      {typeof count === 'number' && <span className="stars-count">({count})</span>}
    </span>
  );
}

function Modal({
  open,
  title: heading,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={heading}>
        <header className="modal-head">
          <h2>{heading}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Picture field: thumbnails, upload from this device, or paste a link. */
function ImagePicker({
  value,
  onChange,
  max = 8,
  hint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  hint?: string;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    if (value.length >= max) {
      notify(`You can add up to ${max} picture(s).`, 'error');
      return;
    }
    const chosen = Array.from(files).slice(0, max - value.length);
    setBusy(true);
    const added: string[] = [];
    try {
      for (const file of chosen) added.push(await uploadImageFile(file));
      onChange([...value, ...added]);
      notify(added.length > 1 ? `${added.length} pictures uploaded.` : 'Picture uploaded.', 'success');
    } catch (err) {
      if (added.length) onChange([...value, ...added]);
      notify(err instanceof Error ? err.message : 'Could not upload that image.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="image-picker">
      {value.length > 0 && (
        <div className="image-picker-grid">
          {value.map((url, i) => (
            <div key={`${url}-${i}`} className="image-picker-thumb">
              <img src={assetUrl(url)} alt={`Picture ${i + 1}`} />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove picture"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
              {i === 0 && max > 1 && <span className="image-picker-tag">Cover</span>}
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <label className="btn btn-outline btn-sm" style={{ cursor: busy ? 'progress' : 'pointer' }}>
          {busy ? 'Uploading…' : 'Upload from this device'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            multiple={max > 1}
            disabled={busy}
            onChange={(e) => {
              const files = e.target.files;
              e.target.value = '';
              void pick(files);
            }}
          />
        </label>
        {value.length < max && (
          <>
            <input
              placeholder="…or paste an image link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              style={{ flex: '1 1 220px' }}
            />
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={!link.trim()}
              onClick={() => {
                onChange([...value, link.trim()]);
                setLink('');
              }}
            >
              Use this link
            </Button>
          </>
        )}
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function Price({ value, compare }: { value: number; compare?: number }) {
  return (
    <span className="price">
      <strong>{taka(value)}</strong>
      {!!compare && compare > value && <s>{taka(compare)}</s>}
    </span>
  );
}

function ProductImage({ product, className }: { product: Pick<Product, 'images' | 'name'>; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = assetUrl(product.images[0]?.url ?? '');
  if (!src || broken) {
    return (
      <div className={cx('img-fallback', className)} aria-label={product.name}>
        <span>{initials(product.name)}</span>
      </div>
    );
  }
  return <img className={className} src={src} alt={product.images[0]?.alt || product.name} loading="lazy" onError={() => setBroken(true)} />;
}

/** Staff-only gate. The API re-checks the role on every request. */
function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) {
    return <Navigate to={`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (user.role === 'customer') {
    return (
      <Empty
        title="Staff access only"
        text="Your account does not have dashboard permissions. Use the storefront for shopping."
        action={
          <a className="btn btn-primary" href={STORE_URL}>
            Go to the store
          </a>
        }
      />
    );
  }
  return <>{children}</>;
}

/* =============================================================================
 * 18. DASHBOARD — LAYOUT
 * ========================================================================== */

const ADMIN_NAV = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/orders', label: 'Orders' },
  { to: '/admin/products', label: 'Products' },
  { to: '/admin/categories', label: 'Categories' },
  { to: '/admin/customers', label: 'Customers' },
  { to: '/admin/coupons', label: 'Coupons' },
  { to: '/admin/reviews', label: 'Reviews' },
  { to: '/admin/messages', label: 'Messages' },
  { to: '/admin/settings', label: 'Store settings' },
  { to: '/admin/audit', label: 'Audit log' },
];

function AdminLayout() {
  const { user, logout } = useAuth();
  const settings = useSettings();
  const isAdmin = user?.role === 'admin';
  return (
    <div className="admin-shell">
      <aside className="admin-side">
        <Link to="/admin" className="admin-brand">
          <img className="admin-logo" src={`${import.meta.env.BASE_URL}brand/nivora-logo.png`} alt={settings.storeName} />
          <small>Dashboard</small>
        </Link>
        <nav className="admin-nav">
          {ADMIN_NAV.filter((n) => n.to !== '/admin/settings' || isAdmin).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('admin-link', isActive && 'active')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="admin-side-foot">
          <span>{user?.name} · {user?.role}</span>
          <a href={STORE_URL}>← Back to storefront</a>
          <button className="admin-link" style={{ border: 0, background: 'none', padding: 0, textAlign: 'left' }} onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="admin-main">
        <Outlet />
      </div>
    </div>
  );
}

function AdminHeader({ title: heading, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  const { user } = useAuth();
  return (
    <div className="admin-top">
      <div>
        <h1>{heading}</h1>
        {subtitle && <p className="muted small" style={{ margin: 0 }}>{subtitle}</p>}
      </div>
      <div className="admin-user">
        {actions}
        <span>{user?.name}</span>
      </div>
    </div>
  );
}

/* =============================================================================
 * 19. DASHBOARD — OVERVIEW
 * ========================================================================== */

interface Stats {
  revenue: number;
  orders: number;
  itemsSold: number;
  averageOrderValue: number;
  today: { revenue: number; orders: number };
  statusBreakdown: { status: string; count: number }[];
  recentOrders: { _id: string; orderNo: string; total: number; status: string; payment: { status: string }; createdAt: string }[];
  lowStock: { _id: string; name: string; label: string; stock: number }[];
  salesSeries: { _id: string; revenue: number; orders: number }[];
  topProducts: { _id: string; name: string; sold: number; images?: Image[] }[];
  pendingPayments: number;
  newCustomers: number;
}

function Sparkline({ data }: { data: { _id: string; revenue: number }[] }) {
  if (data.length < 2) {
    return <p className="muted small">Not enough sales yet to draw a trend.</p>;
  }
  const width = 600;
  const height = 120;
  const max = Math.max(...data.map((d) => d.revenue), 1);
  const step = width / (data.length - 1);
  const points = data.map((d, i) => `${i * step},${height - (d.revenue / max) * (height - 12)}`);
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Revenue trend">
      <polyline points={`0,${height} ${points.join(' ')} ${width},${height}`} fill="rgba(164,68,42,.10)" stroke="none" />
      <polyline points={points.join(' ')} fill="none" stroke="#a4442a" strokeWidth="2" />
    </svg>
  );
}

function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<Stats>('/admin/stats')
      .then(setStats)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load stats.'));
  }, []);
  if (error) return <div className="notice err">{error}</div>;
  if (!stats) return <Spinner label="Loading dashboard…" />;

  const maxStatus = Math.max(...stats.statusBreakdown.map((s) => s.count), 1);

  return (
    <>
      <AdminHeader title="Overview" subtitle="A live snapshot of the store." />
      <div className="stat-grid">
        <div className="stat">
          <span>Revenue</span>
          <strong>{taka(stats.revenue)}</strong>
          <small>{stats.orders} paid or active orders</small>
        </div>
        <div className="stat">
          <span>Today</span>
          <strong>{taka(stats.today.revenue)}</strong>
          <small>{stats.today.orders} order(s) today</small>
        </div>
        <div className="stat">
          <span>Average order</span>
          <strong>{taka(stats.averageOrderValue)}</strong>
          <small>{stats.itemsSold} items sold</small>
        </div>
        <div className="stat">
          <span>Pending payments</span>
          <strong style={{ color: stats.pendingPayments ? 'var(--amber)' : undefined }}>{stats.pendingPayments}</strong>
          <small>Waiting for verification</small>
        </div>
        <div className="stat">
          <span>New customers</span>
          <strong>{stats.newCustomers}</strong>
          <small>Last 14 days</small>
        </div>
      </div>

      <div className="two-panel">
        <div className="panel">
          <div className="panel-head">
            <h2>Revenue, last 14 days</h2>
            <Link className="text-btn" to="/admin/orders">
              All orders →
            </Link>
          </div>
          <Sparkline data={stats.salesSeries} />
          <div className="status-bars mt">
            {stats.statusBreakdown.map((s) => (
              <div key={s.status} className="status-bar">
                <span>{title(s.status)}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${(s.count / maxStatus) * 100}%` }} />
                </span>
                <span>{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Low stock</h2>
            <Link className="text-btn" to="/admin/products">
              Manage →
            </Link>
          </div>
          {stats.lowStock.length === 0 ? (
            <p className="muted small">Everything is comfortably stocked.</p>
          ) : (
            <div className="lowstock">
              {stats.lowStock.map((l) => (
                <div key={`${l._id}-${l.label}`}>
                  <span>
                    {l.name} <span className="muted">· {l.label}</span>
                  </span>
                  <strong style={{ color: l.stock === 0 ? 'var(--red)' : 'var(--amber)' }}>{l.stock}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="two-panel">
        <div className="panel">
          <div className="panel-head">
            <h2>Recent orders</h2>
            <Link className="text-btn" to="/admin/orders">
              View all →
            </Link>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stats.recentOrders.map((o) => (
                  <tr key={o._id}>
                    <td>
                      <strong>{o.orderNo}</strong>
                      <div className="muted small">{dateShort(o.createdAt)}</div>
                    </td>
                    <td>
                      <Badge status={o.status} />
                    </td>
                    <td>
                      <Badge status={o.payment.status} />
                    </td>
                    <td>{taka(o.total)}</td>
                    <td>
                      <Link className="text-btn" to={`/admin/orders/${o._id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h3>Best sellers</h3>
          {stats.topProducts.length === 0 ? (
            <p className="muted small">No sales yet.</p>
          ) : (
            <div className="lowstock">
              {stats.topProducts.map((p) => (
                <div key={p._id}>
                  <span>{p.name}</span>
                  <strong>{p.sold}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* =============================================================================
 * 20. DASHBOARD — PRODUCTS
 * ========================================================================== */

interface VariantDraft {
  _id?: string;
  label: string;
  sku: string;
  price: string;
  compare: string;
  stock: string;
}

interface ProductDraft {
  id?: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  images: string[];
  tags: string;
  isActive: boolean;
  isFeatured: boolean;
  variants: VariantDraft[];
}

const emptyDraft = (categoryId: string): ProductDraft => ({
  name: '',
  slug: '',
  description: '',
  category: categoryId,
  images: [],
  tags: '',
  isActive: true,
  isFeatured: false,
  variants: [{ label: 'Default', sku: '', price: '', compare: '', stock: '0' }],
});

function ProductsAdminPage() {
  const { notify } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const debouncedQ = useDebounced(q, 350);
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const search = new URLSearchParams({ page: String(page), limit: '20' });
    if (debouncedQ) search.set('q', debouncedQ);
    if (category) search.set('category', category);
    if (active) search.set('active', active);
    api
      .get<{ products: Product[]; categories: Category[]; total: number; pages: number }>(`/admin/products?${search.toString()}`)
      .then((r) => {
        setProducts(r.products);
        setCategories(r.categories);
        setTotal(r.total);
        setPages(r.pages);
      })
      .catch((e: unknown) => notify(e instanceof Error ? e.message : 'Could not load products.', 'error'))
      .finally(() => setLoading(false));
  }, [debouncedQ, category, active, page, notify]);

  useEffect(() => {
    load();
  }, [load]);

  function openNew() {
    setFormError('');
    setDraft(emptyDraft(categories[0] ? String(categories[0]._id ?? categories[0].id) : ''));
  }

  function openEdit(p: Product) {
    setFormError('');
    setDraft({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      category: p.categoryId,
      images: p.images.map((i) => i.url),
      tags: p.tags.join(', '),
      isActive: p.isActive !== false,
      isFeatured: p.isFeatured,
      variants: p.variants.map((v) => ({
        _id: v._id,
        label: v.label,
        sku: v.sku ?? '',
        price: fromPoisha(v.price),
        compare: v.compareAtPrice ? fromPoisha(v.compareAtPrice) : '',
        stock: String(v.stock),
      })),
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setFormError('');
    const images = draft.images.map((url) => ({ url, alt: draft.name }));
    const variants = draft.variants.map((v) => ({
      ...(v._id ? { _id: v._id } : {}),
      label: v.label.trim(),
      sku: v.sku.trim(),
      price: toPoisha(v.price),
      compareAtPrice: v.compare ? toPoisha(v.compare) : 0,
      stock: Math.max(0, parseInt(v.stock || '0', 10) || 0),
    }));
    if (variants.some((v) => !v.label || v.price <= 0)) {
      setFormError('Every option needs a label and a price above zero.');
      return;
    }
    const payload = {
      name: draft.name.trim(),
      slug: draft.slug.trim() || undefined,
      description: draft.description.trim(),
      category: draft.category,
      images,
      tags: draft.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      isActive: draft.isActive,
      isFeatured: draft.isFeatured,
      variants,
    };
    setSaving(true);
    try {
      if (draft.id) await api.patch(`/admin/products/${draft.id}`, payload);
      else await api.post('/admin/products', payload);
      notify(draft.id ? 'Product updated.' : 'Product created.', 'success');
      setDraft(null);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the product.');
    } finally {
      setSaving(false);
    }
  }

  async function archive(p: Product) {
    if (!window.confirm(`Archive “${p.name}”? It will be hidden from the shop but kept in past orders.`)) return;
    try {
      await api.del(`/admin/products/${p.id}`);
      notify('Product archived.', 'info');
      load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not archive the product.', 'error');
    }
  }

  async function restore(p: Product) {
    try {
      await api.patch(`/admin/products/${p.id}`, { isActive: true });
      notify('Product restored.', 'success');
      load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not restore the product.', 'error');
    }
  }

  function updateDraft(patch: Partial<ProductDraft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  function updateVariant(index: number, patch: Partial<VariantDraft>) {
    setDraft((d) =>
      d ? { ...d, variants: d.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)) } : d
    );
  }

  return (
    <>
      <AdminHeader
        title="Products"
        subtitle={`${total} product(s) in the catalogue`}
        actions={
          <Button variant="primary" size="sm" onClick={openNew}>
            + New product
          </Button>
        }
      />
      <div className="panel">
        <div className="toolbar">
          <input placeholder="Search products…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="grow" />
          <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={String(c._id ?? c.id)} value={String(c._id ?? c.id)}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="1">Active</option>
            <option value="0">Archived</option>
          </select>
        </div>

        {loading ? (
          <Spinner label="Loading products…" />
        ) : products.length === 0 ? (
          <Empty title="No products match" text="Adjust the filters or create a new product." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Stock</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const stock = p.variants.reduce((n, v) => n + v.stock, 0);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
                          <div style={{ width: 40, height: 52, borderRadius: 6, overflow: 'hidden', flex: '0 0 auto' }}>
                            <ProductImage product={p} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <strong>{p.name}</strong>
                            <div className="muted small">
                              {p.variants.length} option(s) · {p.sold} sold
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{p.category ?? '—'}</td>
                      <td>{taka(p.priceMin)}</td>
                      <td style={{ color: stock === 0 ? 'var(--red)' : stock <= 5 ? 'var(--amber)' : undefined }}>{stock}</td>
                      <td>
                        <Badge status={p.isActive === false ? 'inactive' : 'active'} />
                        {p.isFeatured && <span className="badge" style={{ marginLeft: 4 }}>Featured</span>}
                      </td>
                      <td>
                        <div className="table-actions">
                          <button className="text-btn" onClick={() => openEdit(p)}>
                            Edit
                          </button>
                          {p.isActive === false ? (
                            <button className="text-btn" onClick={() => void restore(p)}>
                              Restore
                            </button>
                          ) : (
                            <button className="text-btn" style={{ color: 'var(--red)' }} onClick={() => void archive(p)}>
                              Archive
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ‹
            </button>
            <span className="muted small" style={{ alignSelf: 'center' }}>
              Page {page} of {pages}
            </span>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              ›
            </button>
          </div>
        )}
      </div>

      <Modal open={!!draft} title={draft?.id ? 'Edit product' : 'New product'} onClose={() => setDraft(null)} wide>
        {draft && (
          <form className="stack" onSubmit={save}>
            {formError && <div className="notice err">{formError}</div>}
            <div className="form-grid">
              <Field label="Name">
                <input required minLength={2} maxLength={140} value={draft.name} onChange={(e) => updateDraft({ name: e.target.value })} />
              </Field>
              <Field label="Slug" hint="Leave blank to generate from the name.">
                <input value={draft.slug} maxLength={160} onChange={(e) => updateDraft({ slug: e.target.value })} />
              </Field>
              <Field label="Category">
                <select required value={draft.category} onChange={(e) => updateDraft({ category: e.target.value })}>
                  <option value="">Choose…</option>
                  {categories.map((c) => (
                    <option key={String(c._id ?? c.id)} value={String(c._id ?? c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tags" hint="Comma separated, e.g. kurti-set, new">
                <input value={draft.tags} onChange={(e) => updateDraft({ tags: e.target.value })} />
              </Field>
              <div className="field full">
                <span className="field-label">Pictures</span>
                <ImagePicker
                  value={draft.images}
                  onChange={(images) => updateDraft({ images })}
                  max={8}
                  hint="Upload from this device or paste a link. First picture is the cover — up to 8."
                />
              </div>
              <Field label="Description" className="full">
                <textarea maxLength={6000} value={draft.description} onChange={(e) => updateDraft({ description: e.target.value })} />
              </Field>
              <div className="row full" style={{ gap: 18 }}>
                <label className="checkbox">
                  <input type="checkbox" checked={draft.isActive} onChange={(e) => updateDraft({ isActive: e.target.checked })} />
                  Visible in the shop
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={draft.isFeatured} onChange={(e) => updateDraft({ isFeatured: e.target.checked })} />
                  Featured on the home page
                </label>
              </div>
            </div>

            <div>
              <div className="panel-head">
                <h3>Options &amp; stock</h3>
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  onClick={() => setDraft((d) => (d ? { ...d, variants: [...d.variants, { label: '', sku: '', price: '', compare: '', stock: '0' }] } : d))}
                >
                  + Add option
                </Button>
              </div>
              {draft.variants.map((v, i) => (
                <div key={v._id ?? i} className="variant-editor">
                  <div className="variant-row">
                    <Field label="Label">
                      <input required value={v.label} onChange={(e) => updateVariant(i, { label: e.target.value })} placeholder="e.g. Kurti + Palazzo" />
                    </Field>
                    <Field label="Price (৳)">
                      <input required type="number" min="1" step="0.01" value={v.price} onChange={(e) => updateVariant(i, { price: e.target.value })} />
                    </Field>
                    <Field label="Compare at (৳)">
                      <input type="number" min="0" step="0.01" value={v.compare} onChange={(e) => updateVariant(i, { compare: e.target.value })} />
                    </Field>
                    <Field label="Stock">
                      <input type="number" min="0" step="1" value={v.stock} onChange={(e) => updateVariant(i, { stock: e.target.value })} />
                    </Field>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Remove option"
                      disabled={draft.variants.length === 1}
                      onClick={() => setDraft((d) => (d ? { ...d, variants: d.variants.filter((_, idx) => idx !== i) } : d))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="form-actions">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                {draft.id ? 'Save changes' : 'Create product'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

/* =============================================================================
 * 21. DASHBOARD — CATEGORIES
 * ========================================================================== */

interface CategoryDraft {
  id?: string;
  name: string;
  slug: string;
  description: string;
  image: string;
  sortOrder: string;
  isActive: boolean;
}

function CategoriesAdminPage() {
  const { notify } = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ categories: Category[] }>('/admin/categories')
      .then((r) => setCategories(r.categories))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : 'Could not load categories.', 'error'))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError('');
    const payload = {
      name: draft.name.trim(),
      slug: draft.slug.trim() || undefined,
      description: draft.description.trim(),
      image: draft.image.trim(),
      sortOrder: parseInt(draft.sortOrder || '0', 10) || 0,
      isActive: draft.isActive,
    };
    try {
      if (draft.id) await api.patch(`/admin/categories/${draft.id}`, payload);
      else await api.post('/admin/categories', payload);
      notify(draft.id ? 'Category updated.' : 'Category created.', 'success');
      setDraft(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the category.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: Category) {
    if (!window.confirm(`Delete the “${c.name}” category?`)) return;
    try {
      await api.del(`/admin/categories/${c._id ?? c.id}`);
      notify('Category deleted.', 'info');
      load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not delete the category.', 'error');
    }
  }

  return (
    <>
      <AdminHeader
        title="Categories"
        subtitle="Groups used by the shop filters and home page."
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setError('');
              setDraft({ name: '', slug: '', description: '', image: '', sortOrder: '0', isActive: true });
            }}
          >
            + New category
          </Button>
        }
      />
      <div className="panel">
        {loading ? (
          <Spinner />
        ) : categories.length === 0 ? (
          <Empty title="No categories yet" text="Create your first category to organise the catalogue." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c._id ?? c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      {c.description && <div className="muted small">{c.description}</div>}
                    </td>
                    <td className="mono">{c.slug}</td>
                    <td>{c.sortOrder ?? 0}</td>
                    <td>
                      <Badge status={c.isActive === false ? 'inactive' : 'active'} />
                    </td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="text-btn"
                          onClick={() => {
                            setError('');
                            setDraft({
                              id: String(c._id ?? c.id),
                              name: c.name,
                              slug: c.slug,
                              description: c.description ?? '',
                              image: c.image ?? '',
                              sortOrder: String(c.sortOrder ?? 0),
                              isActive: c.isActive !== false,
                            });
                          }}
                        >
                          Edit
                        </button>
                        <button className="text-btn" style={{ color: 'var(--red)' }} onClick={() => void remove(c)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!draft} title={draft?.id ? 'Edit category' : 'New category'} onClose={() => setDraft(null)}>
        {draft && (
          <form className="stack" onSubmit={save}>
            {error && <div className="notice err">{error}</div>}
            <Field label="Name">
              <input required minLength={2} maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Slug" hint="Leave blank to generate from the name.">
              <input value={draft.slug} maxLength={80} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
            </Field>
            <Field label="Description">
              <input maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="field">
              <span className="field-label">Cover picture</span>
              <ImagePicker
                value={draft.image ? [draft.image] : []}
                onChange={(next) => setDraft({ ...draft, image: next[0] ?? '' })}
                max={1}
                hint="Upload from this device or paste a link."
              />
            </div>
            <div className="form-grid">
              <Field label="Sort order">
                <input type="number" min="0" max="999" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} />
              </Field>
              <label className="checkbox" style={{ alignSelf: 'end', paddingBottom: 10 }}>
                <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
                Active
              </label>
            </div>
            <div className="form-actions">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
/* =============================================================================
 * 22. DASHBOARD — ORDERS
 * ========================================================================== */

const PAYMENT_STATUSES = ['unpaid', 'pending_verification', 'paid', 'failed', 'refunded'] as const;

function OrdersAdminPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [payment, setPayment] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const debouncedQ = useDebounced(q, 350);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const search = new URLSearchParams({ page: String(page), limit: '20' });
    if (status) search.set('status', status);
    if (payment) search.set('payment', payment);
    if (debouncedQ) search.set('q', debouncedQ);
    api
      .get<{ orders: Order[]; total: number; pages: number }>(`/admin/orders?${search.toString()}`)
      .then((r) => {
        if (!active) return;
        setOrders(r.orders);
        setTotal(r.total);
        setPages(r.pages);
        setError('');
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'Could not load orders.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [page, status, payment, debouncedQ]);

  return (
    <>
      <AdminHeader title="Orders" subtitle={`${total} order(s)`} />
      <div className="panel">
        <div className="toolbar">
          <input
            placeholder="Order no, name or phone…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            className="grow"
          />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {Object.keys(STATUS_TRANSITIONS).map((s) => (
              <option key={s} value={s}>
                {title(s)}
              </option>
            ))}
          </select>
          <select value={payment} onChange={(e) => { setPayment(e.target.value); setPage(1); }}>
            <option value="">All payments</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {title(s.replace(/_/g, ' '))}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="notice err mb">{error}</div>}
        {loading ? (
          <Spinner />
        ) : orders.length === 0 ? (
          <Empty title="No orders match" text="Try clearing the filters." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o._id}>
                    <td>
                      <strong>{o.orderNo}</strong>
                      <div className="muted small">{dateShort(o.createdAt)}</div>
                    </td>
                    <td>
                      {o.shippingAddress.name}
                      <div className="muted small">{o.shippingAddress.phone}</div>
                    </td>
                    <td>{o.items.reduce((n, i) => n + i.qty, 0)}</td>
                    <td>{taka(o.total)}</td>
                    <td>
                      <Badge status={o.status} />
                    </td>
                    <td>
                      <Badge status={o.payment.status} />
                      <div className="muted small">{o.payment.method.toUpperCase()}</div>
                    </td>
                    <td>
                      <Link className="text-btn" to={`/admin/orders/${o._id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ‹
            </button>
            <span className="muted small" style={{ alignSelf: 'center' }}>
              Page {page} of {pages}
            </span>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              ›
            </button>
          </div>
        )}
      </div>
    </>
  );
}

interface AdminCustomer {
  id?: string;
  _id: string;
  name: string;
  email: string;
  phone: string;
  role: 'customer' | 'manager' | 'admin';
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string;
  totalSpent: number;
  orderCount: number;
}

function AdminOrderPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { notify } = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<AdminCustomer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const isAdmin = user?.role === 'admin';

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ order: Order; customer: AdminCustomer | null }>(`/admin/orders/${encodeURIComponent(id)}`)
      .then((r) => {
        setOrder(r.order);
        setCustomer(r.customer);
        setAdminNote(r.order.adminNote ?? '');
        setError('');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the order.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(next: OrderStatus) {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api.patch<{ order: Order }>(`/admin/orders/${order._id}/status`, { status: next, note });
      setOrder(r.order);
      setNote('');
      notify(`Order moved to ${next}.`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not change status.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function setPaymentStatus(next: string) {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api.patch<{ order: Order }>(`/admin/orders/${order._id}/payment`, { status: next });
      setOrder(r.order);
      notify('Payment updated.', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update payment.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveAdminNote() {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api.patch<{ order: Order }>(`/admin/orders/${order._id}/note`, { adminNote });
      setOrder(r.order);
      notify('Internal note saved.', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not save note.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Loading order…" />;
  if (error || !order) {
    return (
      <Empty
        title="Order not found"
        text={error}
        action={
          <Link className="btn btn-outline" to="/admin/orders">
            Back to orders
          </Link>
        }
      />
    );
  }

  const nextSteps = STATUS_TRANSITIONS[order.status] ?? [];

  return (
    <>
      <AdminHeader
        title={order.orderNo}
        subtitle={`Placed ${dateTime(order.createdAt)} · ${order.shippingAddress.name} · ${order.shippingAddress.phone}`}
        actions={
          <Link className="btn btn-outline btn-sm" to="/admin/orders">
            ← All orders
          </Link>
        }
      />

      <div className="detail-grid">
        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>Items</h3>
              <div className="row">
                <Badge status={order.status} />
                <Badge status={order.payment.status} />
              </div>
            </div>
            {order.items.map((item) => (
              <div key={`${item.variantId}-${item.name}`} className="row-between" style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }}>
                <div>
                  <strong className="small">{item.name}</strong>
                  <div className="muted small">
                    {item.variantLabel} · {taka(item.unitPrice)} × {item.qty}
                  </div>
                </div>
                <strong>{taka(item.lineTotal)}</strong>
              </div>
            ))}
            <div className="sum-row">
              <span>Subtotal</span>
              <span>{taka(order.subtotal)}</span>
            </div>
            {order.discount > 0 && (
              <div className="sum-row" style={{ color: 'var(--green)' }}>
                <span>Discount {order.couponCode && `(${order.couponCode})`}</span>
                <span>−{taka(order.discount)}</span>
              </div>
            )}
            <div className="sum-row">
              <span>Delivery</span>
              <span>{order.shipping === 0 ? 'Free' : taka(order.shipping)}</span>
            </div>
            <div className="sum-row total">
              <span>Total</span>
              <span>{taka(order.total)}</span>
            </div>
          </div>

          <div className="panel">
            <h3>Fulfilment</h3>
            {nextSteps.length === 0 ? (
              <p className="muted small">This order is closed — no further transitions.</p>
            ) : (
              <>
                {order.status === 'pending' && (
                  <div className="notice warn mb">
                    Confirm after checking stock and, for wallet payments, verifying the transaction id.
                  </div>
                )}
                <Field label="Note for the timeline (optional)">
                  <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called customer to confirm" />
                </Field>
                <div className="row mt">
                  {nextSteps.map((s) => (
                    <Button
                      key={s}
                      variant={s === 'cancelled' || s === 'returned' ? 'danger' : 'primary'}
                      size="sm"
                      loading={busy}
                      onClick={() => void setStatus(s)}
                    >
                      {s === 'cancelled' ? 'Cancel order' : s === 'returned' ? 'Mark returned' : `Move to ${s}`}
                    </Button>
                  ))}
                </div>
              </>
            )}
            <hr className="hr" />
            <Field label="Internal note (not shown to the customer)">
              <textarea value={adminNote} maxLength={400} onChange={(e) => setAdminNote(e.target.value)} style={{ minHeight: 68 }} />
            </Field>
            <div className="form-actions">
              <Button variant="subtle" size="sm" loading={busy} onClick={() => void saveAdminNote()}>
                Save note
              </Button>
            </div>
          </div>

          <div className="panel">
            <h3>Timeline</h3>
            <div className="timeline">
              {order.statusHistory.map((h, i) => (
                <div key={`${h.status}-${i}`} className="step done">
                  <span className="dot" />
                  <div>
                    <strong>{title(h.status)}</strong>
                    <span>
                      {dateTime(h.at)}
                      {h.note ? ` · ${h.note}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h3>Payment</h3>
            <dl className="kv">
              <dt>Method</dt>
              <dd>{order.payment.method.toUpperCase()}</dd>
              <dt>Status</dt>
              <dd>
                <Badge status={order.payment.status} />
              </dd>
              {order.payment.trxId && (
                <>
                  <dt>Transaction</dt>
                  <dd className="mono">{order.payment.trxId}</dd>
                </>
              )}
              {order.payment.senderPhone && (
                <>
                  <dt>Sender</dt>
                  <dd>{order.payment.senderPhone}</dd>
                </>
              )}
              {order.payment.verifiedAt && (
                <>
                  <dt>Verified</dt>
                  <dd>{dateTime(order.payment.verifiedAt)}</dd>
                </>
              )}
            </dl>
            {isAdmin ? (
              <div className="mt">
                <Field label="Update payment status">
                  <select value={order.payment.status} onChange={(e) => void setPaymentStatus(e.target.value)} disabled={busy}>
                    {PAYMENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {title(s.replace(/_/g, ' '))}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="muted small mt">
                  Verify the transaction in your bKash/Nagad statement before marking an order paid.
                </p>
              </div>
            ) : (
              <p className="muted small mt">Only an admin can change payment status.</p>
            )}
          </div>

          <div className="panel">
            <h3>Delivery address</h3>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{order.shippingAddress.name}</dd>
              <dt>Phone</dt>
              <dd>{order.shippingAddress.phone}</dd>
              <dt>Address</dt>
              <dd>
                {order.shippingAddress.address}, {order.shippingAddress.area}, {order.shippingAddress.city},{' '}
                {order.shippingAddress.district}
                {order.shippingAddress.postcode ? ` ${order.shippingAddress.postcode}` : ''}
              </dd>
              {order.note && (
                <>
                  <dt>Customer note</dt>
                  <dd>{order.note}</dd>
                </>
              )}
            </dl>
          </div>

          {customer && (
            <div className="panel">
              <h3>Customer</h3>
              <dl className="kv">
                <dt>Name</dt>
                <dd>{customer.name}</dd>
                <dt>Email</dt>
                <dd>{customer.email}</dd>
                <dt>Phone</dt>
                <dd>{customer.phone}</dd>
                <dt>Since</dt>
                <dd>{dateShort(customer.createdAt)}</dd>
              </dl>
              <Link className="text-btn mt" to="/admin/customers">
                Open customer list →
              </Link>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* =============================================================================
 * 23. DASHBOARD — CUSTOMERS
 * ========================================================================== */

function CustomersAdminPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const debouncedQ = useDebounced(q, 350);
  const isAdmin = user?.role === 'admin';

  const load = useCallback(() => {
    setLoading(true);
    const search = new URLSearchParams();
    if (debouncedQ) search.set('q', debouncedQ);
    api
      .get<{ customers: AdminCustomer[] }>(`/admin/customers?${search.toString()}`)
      .then((r) => setCustomers(r.customers))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : 'Could not load customers.', 'error'))
      .finally(() => setLoading(false));
  }, [debouncedQ, notify]);

  useEffect(() => {
    load();
  }, [load]);

  async function update(c: AdminCustomer, patch: { isActive?: boolean; role?: string }) {
    setBusy(c._id);
    try {
      await api.patch(`/admin/customers/${c._id}`, patch);
      notify('Customer updated.', 'success');
      load();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update customer.', 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <AdminHeader title="Customers" subtitle="Accounts, spend and access." />
      <div className="panel">
        <div className="toolbar">
          <input placeholder="Search name, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
        </div>
        {loading ? (
          <Spinner />
        ) : customers.length === 0 ? (
          <Empty title="No customers yet" text="Accounts will appear here after the first sign-up." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Orders</th>
                  <th>Spent</th>
                  <th>Joined</th>
                  <th>Status</th>
                  {isAdmin && <th>Access</th>}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c._id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted small">{c.email}</div>
                      <div className="muted small">{c.phone}</div>
                    </td>
                    <td>{c.orderCount}</td>
                    <td>{taka(c.totalSpent)}</td>
                    <td>{dateShort(c.createdAt)}</td>
                    <td>
                      <Badge status={c.isActive ? 'active' : 'inactive'} />
                    </td>
                    {isAdmin && (
                      <td>
                        <div className="table-actions">
                          <select
                            value={c.role}
                            disabled={busy === c._id}
                            onChange={(e) => void update(c, { role: e.target.value })}
                            style={{ width: 'auto', padding: '5px 8px', fontSize: '.78rem' }}
                            aria-label={`Role for ${c.name}`}
                          >
                            <option value="customer">Customer</option>
                            <option value="manager">Manager</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button
                            className="text-btn"
                            disabled={busy === c._id}
                            onClick={() => void update(c, { isActive: !c.isActive })}
                          >
                            {c.isActive ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* =============================================================================
 * 24. DASHBOARD — COUPONS
 * ========================================================================== */

interface Coupon {
  _id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  minSubtotal: number;
  maxDiscount: number;
  usageLimit: number;
  usedCount: number;
  perUserLimit: number;
  startsAt: string;
  expiresAt?: string | null;
  isActive: boolean;
}

interface CouponDraft {
  id?: string;
  code: string;
  type: 'percent' | 'fixed';
  value: string;
  minSubtotal: string;
  maxDiscount: string;
  usageLimit: string;
  perUserLimit: string;
  expiresAt: string;
  isActive: boolean;
}

function CouponsAdminPage() {
  const { notify } = useToast();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<CouponDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ coupons: Coupon[] }>('/admin/coupons')
      .then((r) => setCoupons(r.coupons))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : 'Could not load coupons.', 'error'))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError('');
    const payload = {
      code: draft.code.trim().toUpperCase(),
      type: draft.type,
      // Percentages are whole numbers, fixed discounts are money (poisha).
      value: draft.type === 'percent' ? Math.round(Number(draft.value)) : toPoisha(draft.value),
      minSubtotal: toPoisha(draft.minSubtotal || '0'),
      maxDiscount: toPoisha(draft.maxDiscount || '0'),
      usageLimit: parseInt(draft.usageLimit || '0', 10) || 0,
      perUserLimit: Math.max(1, parseInt(draft.perUserLimit || '1', 10) || 1),
      ...(draft.expiresAt ? { expiresAt: new Date(draft.expiresAt).toISOString() } : {}),
      isActive: draft.isActive,
    };
    if (payload.value <= 0) {
      setError('Value must be greater than zero.');
      setSaving(false);
      return;
    }
    try {
      if (draft.id) await api.patch(`/admin/coupons/${draft.id}`, payload);
      else await api.post('/admin/coupons', payload);
      notify(draft.id ? 'Coupon updated.' : 'Coupon created.', 'success');
      setDraft(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the coupon.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: Coupon) {
    if (!window.confirm(`Delete coupon ${c.code}?`)) return;
    try {
      await api.del(`/admin/coupons/${c._id}`);
      notify('Coupon deleted.', 'info');
      load();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not delete the coupon.', 'error');
    }
  }

  return (
    <>
      <AdminHeader
        title="Coupons"
        subtitle="Discounts are always recalculated on the server at checkout."
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setError('');
              setDraft({
                code: '',
                type: 'percent',
                value: '10',
                minSubtotal: '0',
                maxDiscount: '0',
                usageLimit: '0',
                perUserLimit: '1',
                expiresAt: '',
                isActive: true,
              });
            }}
          >
            + New coupon
          </Button>
        }
      />
      <div className="panel">
        {loading ? (
          <Spinner />
        ) : coupons.length === 0 ? (
          <Empty title="No coupons yet" text="Create a code to run your first promotion." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Discount</th>
                  <th>Min. order</th>
                  <th>Used</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c._id}>
                    <td>
                      <strong className="mono">{c.code}</strong>
                    </td>
                    <td>{c.type === 'percent' ? `${c.value}%` : taka(c.value)}</td>
                    <td>{c.minSubtotal ? taka(c.minSubtotal) : '—'}</td>
                    <td>
                      {c.usedCount}
                      {c.usageLimit ? ` / ${c.usageLimit}` : ''}
                    </td>
                    <td>{c.expiresAt ? dateShort(c.expiresAt) : 'Never'}</td>
                    <td>
                      <Badge status={c.isActive ? 'active' : 'inactive'} />
                    </td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="text-btn"
                          onClick={() => {
                            setError('');
                            setDraft({
                              id: c._id,
                              code: c.code,
                              type: c.type,
                              value: c.type === 'percent' ? String(c.value) : fromPoisha(c.value),
                              minSubtotal: fromPoisha(c.minSubtotal),
                              maxDiscount: fromPoisha(c.maxDiscount),
                              usageLimit: String(c.usageLimit),
                              perUserLimit: String(c.perUserLimit),
                              expiresAt: c.expiresAt ? c.expiresAt.slice(0, 10) : '',
                              isActive: c.isActive,
                            });
                          }}
                        >
                          Edit
                        </button>
                        <button className="text-btn" style={{ color: 'var(--red)' }} onClick={() => void remove(c)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!draft} title={draft?.id ? 'Edit coupon' : 'New coupon'} onClose={() => setDraft(null)}>
        {draft && (
          <form className="stack" onSubmit={save}>
            {error && <div className="notice err">{error}</div>}
            <div className="form-grid">
              <Field label="Code">
                <input required minLength={3} maxLength={30} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Type">
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as 'percent' | 'fixed' })}>
                  <option value="percent">Percent</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </Field>
              <Field label={draft.type === 'percent' ? 'Percent off' : 'Amount off (৳)'}>
                <input required type="number" min="1" step={draft.type === 'percent' ? '1' : '0.01'} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </Field>
              <Field label="Minimum order (৳)" hint="0 means no minimum">
                <input type="number" min="0" step="0.01" value={draft.minSubtotal} onChange={(e) => setDraft({ ...draft, minSubtotal: e.target.value })} />
              </Field>
              <Field label="Max discount (৳)" hint="0 means no cap">
                <input type="number" min="0" step="0.01" value={draft.maxDiscount} onChange={(e) => setDraft({ ...draft, maxDiscount: e.target.value })} />
              </Field>
              <Field label="Total uses" hint="0 means unlimited">
                <input type="number" min="0" value={draft.usageLimit} onChange={(e) => setDraft({ ...draft, usageLimit: e.target.value })} />
              </Field>
              <Field label="Uses per customer">
                <input type="number" min="1" max="100" value={draft.perUserLimit} onChange={(e) => setDraft({ ...draft, perUserLimit: e.target.value })} />
              </Field>
              <Field label="Expires">
                <input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} />
              </Field>
              <label className="checkbox full">
                <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
                Active
              </label>
            </div>
            <div className="form-actions">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Save coupon
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

/* =============================================================================
 * 25. DASHBOARD — REVIEWS
 * ========================================================================== */

interface AdminReview {
  _id: string;
  name: string;
  rating: number;
  title: string;
  body: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  product?: { name: string; slug: string } | null;
}

function ReviewsAdminPage() {
  const { notify } = useToast();
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [status, setStatus] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const search = status ? `?status=${status}` : '';
    api
      .get<{ reviews: AdminReview[] }>(`/admin/reviews${search}`)
      .then((r) => setReviews(r.reviews))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : 'Could not load reviews.', 'error'))
      .finally(() => setLoading(false));
  }, [status, notify]);

  useEffect(() => {
    load();
  }, [load]);

  async function moderate(id: string, next: 'approved' | 'rejected' | 'pending') {
    setBusy(id);
    try {
      await api.patch(`/admin/reviews/${id}`, { status: next });
      notify(`Review ${next}.`, 'success');
      load();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update review.', 'error');
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this review permanently?')) return;
    try {
      await api.del(`/admin/reviews/${id}`);
      notify('Review deleted.', 'info');
      load();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not delete review.', 'error');
    }
  }

  return (
    <>
      <AdminHeader title="Reviews" subtitle="Only approved reviews are visible on product pages." />
      <div className="panel">
        <div className="toolbar">
          <div className="chips">
            {['pending', 'approved', 'rejected', ''].map((s) => (
              <button key={s || 'all'} className={cx('chip', status === s && 'on')} onClick={() => setStatus(s)}>
                {s ? title(s) : 'All'}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <Spinner />
        ) : reviews.length === 0 ? (
          <Empty title="No reviews here" text="Reviews land here for moderation after a delivered order." />
        ) : (
          <div className="stack">
            {reviews.map((r) => (
              <div key={r._id} className="order-card">
                <div className="order-card-head">
                  <div>
                    <strong>{r.product?.name ?? 'Product removed'}</strong>
                    <div className="muted small">
                      {r.name} · {dateShort(r.createdAt)}
                    </div>
                  </div>
                  <div className="row">
                    <Stars rating={r.rating} />
                    <Badge status={r.status} />
                  </div>
                </div>
                {r.title && <strong className="small">{r.title}</strong>}
                <p className="small" style={{ margin: 0 }}>{r.body}</p>
                <div className="row">
                  {r.status !== 'approved' && (
                    <Button size="sm" variant="primary" loading={busy === r._id} onClick={() => void moderate(r._id, 'approved')}>
                      Approve
                    </Button>
                  )}
                  {r.status !== 'rejected' && (
                    <Button size="sm" variant="danger" loading={busy === r._id} onClick={() => void moderate(r._id, 'rejected')}>
                      Reject
                    </Button>
                  )}
                  <button className="text-btn" onClick={() => void remove(r._id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* =============================================================================
 * 26. DASHBOARD — MESSAGES
 * ========================================================================== */

interface AdminMessage {
  _id: string;
  name: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

function MessagesAdminPage() {
  const { notify } = useToast();
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ messages: AdminMessage[] }>('/admin/messages')
      .then((r) => setMessages(r.messages))
      .catch((e: unknown) => notify(e instanceof Error ? e.message : 'Could not load messages.', 'error'))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(m: AdminMessage) {
    try {
      await api.patch(`/admin/messages/${m._id}`, { isRead: !m.isRead });
      load();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update the message.', 'error');
    }
  }

  return (
    <>
      <AdminHeader title="Messages" subtitle="Enquiries from the contact form." />
      <div className="panel">
        {loading ? (
          <Spinner />
        ) : messages.length === 0 ? (
          <Empty title="No messages" text="Contact form submissions will show up here." />
        ) : (
          <div className="stack">
            {messages.map((m) => (
              <div key={m._id} className="order-card" style={{ borderLeft: m.isRead ? '1px solid var(--line)' : '3px solid var(--accent)' }}>
                <div className="order-card-head">
                  <div>
                    <strong>{m.subject || 'General enquiry'}</strong>
                    <div className="muted small">
                      {m.name} · {m.email}
                      {m.phone ? ` · ${m.phone}` : ''} · {dateTime(m.createdAt)}
                    </div>
                  </div>
                  <div className="row">
                    <Badge status={m.isRead ? 'active' : 'pending'} />
                    <button className="text-btn" onClick={() => void toggle(m)}>
                      Mark {m.isRead ? 'unread' : 'read'}
                    </button>
                  </div>
                </div>
                <p className="small" style={{ margin: 0, whiteSpace: 'pre-line' }}>{m.message}</p>
                <a className="text-btn" href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.subject || 'Your enquiry'}`)}`}>
                  Reply by email →
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* =============================================================================
 * 27. DASHBOARD — SETTINGS
 * ========================================================================== */

function SettingsAdminPage() {
  const { notify } = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [zones, setZones] = useState<{ district: string; charge: string }[]>([]);
  // Taka values are kept as strings so typing stays predictable; they are
  // converted to poisha once, on save.
  const [ship, setShip] = useState({ free: '0', def: '0' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverUrl, setCoverUrl] = useState('');

  useEffect(() => {
    api
      .get<{ settings: Settings }>('/admin/settings')
      .then((r) => {
        setForm(r.settings);
        setZones(r.settings.shippingZones.map((z) => ({ district: z.district, charge: fromPoisha(z.charge) })));
        setShip({ free: fromPoisha(r.settings.freeShippingThreshold), def: fromPoisha(r.settings.defaultShippingCharge) });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load settings.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner label="Loading settings…" />;
  if (!form) return <div className="notice err">{error || 'Settings unavailable.'}</div>;

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Upload a file from this computer: browser shrinks it, API stores the bytes. */
  async function uploadCoverFile(file: File) {
    setCoverBusy(true);
    try {
      const blob = await shrinkImage(file);
      const token = await csrfToken();
      const res = await fetch(apiUrl('/admin/support-cover'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-csrf-token': token },
        body: blob,
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) throw new Error(data?.error ?? 'Could not upload that image.');
      set('supportCover', data.url);
      notify('Cover saved — it is now served from your own API.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not upload that image.', 'error');
    } finally {
      setCoverBusy(false);
    }
  }

  /** Paste any public image link: the server downloads it once and hosts it. */
  async function importCoverLink() {
    const url = coverUrl.trim();
    if (!url) return;
    setCoverBusy(true);
    try {
      const r = await api.post<{ url: string }>('/admin/support-cover/url', { url });
      set('supportCover', r.url);
      setCoverUrl('');
      notify('Image downloaded and stored on your server.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not download that image.', 'error');
    } finally {
      setCoverBusy(false);
    }
  }

  async function removeCover() {
    setCoverBusy(true);
    try {
      await api.del('/admin/support-cover');
      set('supportCover', '');
      notify('Cover removed.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not remove the cover.', 'error');
    } finally {
      setCoverBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError('');
    try {
      await api.put('/admin/settings', {
        storeName: form.storeName,
        tagline: form.tagline,
        announcement: form.announcement,
        phone: form.phone,
        email: form.email,
        address: form.address,
        facebook: form.facebook,
        instagram: form.instagram,
        whatsapp: form.whatsapp,
        freeShippingThreshold: toPoisha(ship.free),
        codEnabled: form.codEnabled,
        walletEnabled: form.walletEnabled,
        bkashNumber: form.bkashNumber,
        nagadNumber: form.nagadNumber,
        rocketNumber: form.rocketNumber,
        defaultShippingCharge: toPoisha(ship.def),
        returnPolicy: form.returnPolicy,
        supportWhatsapp: form.supportWhatsapp,
        supportMessenger: form.supportMessenger,
        supportEmail: form.supportEmail,
        shippingZones: zones
          .filter((z) => z.district.trim())
          .map((z) => ({ district: z.district.trim(), charge: toPoisha(z.charge) })),
      });
      notify('Store settings saved. Refresh the storefront to see the branding change.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <AdminHeader title="Store settings" subtitle="Branding, contact details, delivery fees and payment switches." />
      <form className="stack" onSubmit={save}>
        {error && <div className="notice err">{error}</div>}
        <div className="panel">
          <h3>Brand</h3>
          <div className="form-grid">
            <Field label="Store name">
              <input required minLength={2} maxLength={80} value={form.storeName} onChange={(e) => set('storeName', e.target.value)} />
            </Field>
            <Field label="Tagline">
              <input maxLength={160} value={form.tagline} onChange={(e) => set('tagline', e.target.value)} />
            </Field>
            <Field label="Announcement bar" className="full" hint="Leave empty to hide the black bar at the top.">
              <input maxLength={200} value={form.announcement} onChange={(e) => set('announcement', e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="panel">
          <h3>Contact</h3>
          <div className="form-grid">
            <Field label="Phone">
              <input maxLength={30} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Email">
              <input maxLength={120} value={form.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="Address" className="full">
              <input maxLength={200} value={form.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label="Facebook URL">
              <input maxLength={200} value={form.facebook} onChange={(e) => set('facebook', e.target.value)} />
            </Field>
            <Field label="Instagram URL">
              <input maxLength={200} value={form.instagram} onChange={(e) => set('instagram', e.target.value)} />
            </Field>
            <Field label="WhatsApp number">
              <input maxLength={200} value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="panel">
          <h3>Delivery &amp; payment</h3>
          <div className="form-grid">
            <Field label="Free delivery over (৳)" hint="0 disables free-delivery threshold">
              <input
                type="number"
                min="0"
                step="1"
                value={ship.free}
                onChange={(e) => setShip((s) => ({ ...s, free: e.target.value }))}
              />
            </Field>
            <Field label="Default delivery charge (৳)">
              <input
                type="number"
                min="0"
                step="1"
                value={ship.def}
                onChange={(e) => setShip((s) => ({ ...s, def: e.target.value }))}
              />
            </Field>
            <Field label="bKash number">
              <input maxLength={30} value={form.bkashNumber} onChange={(e) => set('bkashNumber', e.target.value)} />
            </Field>
            <Field label="Nagad number">
              <input maxLength={30} value={form.nagadNumber} onChange={(e) => set('nagadNumber', e.target.value)} />
            </Field>
            <Field label="Rocket number">
              <input maxLength={30} value={form.rocketNumber} onChange={(e) => set('rocketNumber', e.target.value)} />
            </Field>
            <div className="row" style={{ alignSelf: 'end', gap: 18, paddingBottom: 8 }}>
              <label className="checkbox">
                <input type="checkbox" checked={form.codEnabled} onChange={(e) => set('codEnabled', e.target.checked)} />
                Cash on delivery
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={form.walletEnabled} onChange={(e) => set('walletEnabled', e.target.checked)} />
                Mobile wallets
              </label>
            </div>
            <Field label="Return policy" className="full">
              <textarea maxLength={500} value={form.returnPolicy} onChange={(e) => set('returnPolicy', e.target.value)} style={{ minHeight: 64 }} />
            </Field>
          </div>

          <div className="panel-head mt">
            <h3>District delivery charges</h3>
            <Button
              type="button"
              variant="subtle"
              size="sm"
              onClick={() => setZones((z) => [...z, { district: '', charge: '' }])}
            >
              + Add district
            </Button>
          </div>
          {zones.length === 0 && <p className="muted small">No zones — every district uses the default charge.</p>}
          {zones.map((z, i) => (
            <div key={i} className="zone-row">
              <Field label="District">
                <input
                  value={z.district}
                  onChange={(e) => setZones((cur) => cur.map((x, idx) => (idx === i ? { ...x, district: e.target.value } : x)))}
                />
              </Field>
              <Field label="Charge (৳)">
                <input
                  type="number"
                  min="0"
                  value={z.charge}
                  onChange={(e) => setZones((cur) => cur.map((x, idx) => (idx === i ? { ...x, charge: e.target.value } : x)))}
                />
              </Field>
              <button type="button" className="icon-btn" onClick={() => setZones((cur) => cur.filter((_, idx) => idx !== i))} aria-label="Remove zone">
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>Support center</h3>
          <p className="muted small">
            Powers the floating help button on the storefront. Leave a channel blank to hide that option.
          </p>
          <div className="form-grid">
            <Field label="WhatsApp number or link">
              <input
                maxLength={200}
                placeholder="+8801700000000"
                value={form.supportWhatsapp}
                onChange={(e) => set('supportWhatsapp', e.target.value)}
              />
            </Field>
            <Field label="Facebook Messenger" hint="m.me/yourpage or a full https:// link">
              <input
                maxLength={200}
                placeholder="https://m.me/nivora"
                value={form.supportMessenger}
                onChange={(e) => set('supportMessenger', e.target.value)}
              />
            </Field>
            <Field label="Support email" className="full" hint="Falls back to the contact email above when empty.">
              <input
                maxLength={120}
                value={form.supportEmail}
                onChange={(e) => set('supportEmail', e.target.value)}
              />
            </Field>
          </div>

          <div className="panel-head mt">
            <h3>Hero cover picture</h3>
          </div>
          <p className="muted small">
            Shown as the large picture in the storefront homepage hero, and at the top of the support card.
          </p>
          {form.supportCover ? (
            <div className="cover-preview">
              <img src={assetUrl(form.supportCover)} alt="Support center cover" />
              <Button type="button" variant="danger" size="sm" loading={coverBusy} onClick={() => void removeCover()}>
                Remove
              </Button>
            </div>
          ) : (
            <p className="muted small">No cover yet — the hero falls back to a featured product photo.</p>
          )}
          <div className="row mt">
            <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
              {coverBusy ? 'Working…' : 'Upload from this computer'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void uploadCoverFile(file);
                }}
              />
            </label>
            <input
              placeholder="https://example.com/banner.jpg"
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              style={{ flex: '1 1 240px' }}
            />
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={!coverUrl.trim() || coverBusy}
              onClick={() => void importCoverLink()}
            >
              Use this link
            </Button>
          </div>
          <p className="field-hint mt">
            Either route stores the picture on your own API (/api/support-cover) — nothing is hotlinked from another host.
          </p>
        </div>

        <div className="form-actions">
          <Button type="submit" variant="primary" loading={saving}>
            Save settings
          </Button>
        </div>
      </form>
    </>
  );
}

/* =============================================================================
 * 28. DASHBOARD — AUDIT LOG
 * ========================================================================== */

interface AuditEntry {
  _id: string;
  action: string;
  actorEmail: string;
  targetType: string;
  targetId: string;
  ip: string;
  at: string;
  meta?: Record<string, unknown>;
}

function AuditAdminPage() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ logs: AuditEntry[] }>('/admin/audit')
      .then((r) => setLogs(r.logs))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the audit log.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <AdminHeader title="Audit log" subtitle="Every sensitive action, newest first. Admin only." />
      <div className="panel">
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="notice err">{error}</div>
        ) : logs.length === 0 ? (
          <Empty title="No activity yet" text="Orders, product edits and settings changes are recorded here." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Meta</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l._id}>
                    <td className="small">{dateTime(l.at)}</td>
                    <td>
                      <span className="mono">{l.action}</span>
                    </td>
                    <td className="small">{l.actorEmail || '—'}</td>
                    <td className="small">
                      {l.targetType}
                      {l.targetId ? `: ${l.targetId.slice(-6)}` : ''}
                    </td>
                    <td className="mono small" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {l.meta && Object.keys(l.meta).length ? JSON.stringify(l.meta) : '—'}
                    </td>
                    <td className="mono small">{l.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}


function NotFoundPage() {
  return (
    <div className="admin-main">
      <Empty
        title="Page not found"
        text="That dashboard page does not exist."
        action={
          <Link className="btn btn-primary" to="/admin">
            Back to overview
          </Link>
        }
      />
    </div>
  );
}

/* =============================================================================
 * 29. LOGIN (staff only) — customers never see this app
 * ========================================================================== */

function AdminLoginPage() {
  const { user, setUser } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/admin';
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user && user.role !== 'customer') navigate(next, { replace: true });
  }, [user, navigate, next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ user: User }>('/auth/login', form);
      setUser(r.user);
      if (r.user.role === 'customer') {
        setError('This account does not have dashboard permissions.');
        return;
      }
      notify(`Welcome back, ${r.user.name.split(' ')[0]}.`, 'success');
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <img className="boot-logo" src={`${import.meta.env.BASE_URL}brand/nivora-logo.png`} alt="Nivora" style={{ marginBottom: 16 }} />
        <h1 style={{ fontSize: '1.7rem' }}>Dashboard sign in</h1>
        <p className="muted small">Staff and administrators only.</p>
        {error && <div className="alert alert-error">{error}</div>}
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="muted small mt">
          <a href={STORE_URL}>← Back to the storefront</a>
        </p>
      </form>
    </div>
  );
}

/* =============================================================================
 * 30. ROUTER + MOUNT — served by the API at /admin
 * ========================================================================== */

function App() {
  return (
    <Routes>
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route
        path="/admin"
        element={
          <Protected>
            <AdminLayout />
          </Protected>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="orders" element={<OrdersAdminPage />} />
        <Route path="orders/:id" element={<AdminOrderPage />} />
        <Route path="products" element={<ProductsAdminPage />} />
        <Route path="categories" element={<CategoriesAdminPage />} />
        <Route path="customers" element={<CustomersAdminPage />} />
        <Route path="coupons" element={<CouponsAdminPage />} />
        <Route path="reviews" element={<ReviewsAdminPage />} />
        <Route path="messages" element={<MessagesAdminPage />} />
        <Route path="settings" element={<SettingsAdminPage />} />
        <Route path="audit" element={<AuditAdminPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

function Root() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </SettingsProvider>
    </ToastProvider>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root was not found.');
}

createRoot(container).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
