import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { Button } from "./kit";
import { paths } from "./paths";

type Mode = "login" | "register" | "invite";

function AuthShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="rosf-app rosf-center">
      <div className="rosf-auth-card">
        <p className="rosf-auth-brand">ROS Foundry</p>
        <h1>{title}</h1>
        {children}
        {footer && <div className="rosf-auth-footer">{footer}</div>}
      </div>
    </div>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <label className="rosf-auth-field" htmlFor={id}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function LoginPage({
  allowRegister = true,
}: {
  allowRegister?: boolean;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/auth/login", {
        email: String(f.get("email") || ""),
        password: String(f.get("password") || ""),
      });
      navigate(paths.home(), { replace: true });
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Sign in"
      footer={
        allowRegister ? (
          <>
            First on this instance?{" "}
            <Link to={paths.register()}>Create the owner account</Link>
          </>
        ) : undefined
      }
    >
      <form className="rosf-auth-form" onSubmit={onSubmit}>
        <Field label="Email" id="email">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password" id="password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
          />
        </Field>
        {error && (
          <p className="rosf-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="rosf-form-actions">
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/auth/bootstrap", {
        name: String(f.get("name") || ""),
        email: String(f.get("email") || ""),
        password: String(f.get("password") || ""),
      });
      navigate(paths.home(), { replace: true });
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create account",
      );
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Create owner account"
      footer={
        <>
          Already have an account? <Link to={paths.login()}>Sign in</Link>
        </>
      }
    >
      <form className="rosf-auth-form" onSubmit={onSubmit}>
        <Field label="Name" id="name">
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
          />
        </Field>
        <Field label="Email" id="email">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password" id="password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </Field>
        {error && (
          <p className="rosf-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="rosf-form-actions">
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

export function InvitePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [error, setError] = useState<string | null>(
    token ? null : "Missing invitation token",
  );
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/invitations/accept", {
        token,
        name: String(f.get("name") || ""),
        password: String(f.get("password") || ""),
      });
      navigate(paths.home(), { replace: true });
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not accept invitation",
      );
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Accept invitation"
      footer={
        <>
          Already on this instance? <Link to={paths.login()}>Sign in</Link>
        </>
      }
    >
      <form className="rosf-auth-form" onSubmit={onSubmit}>
        <Field label="Your name" id="name">
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
          />
        </Field>
        <Field label="Choose a password" id="password">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </Field>
        {error && (
          <p className="rosf-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="rosf-form-actions">
          <Button type="submit" disabled={busy || !token}>
            {busy ? "Joining…" : "Join workspace"}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

export type AuthStatus = {
  mode: "local" | "hosted";
  bootstrapped: boolean;
  authenticated: boolean;
};

/** Shown when hosted mode requires sign-in. */
export function HostedAuthGate({ status }: { status: AuthStatus }) {
  const mode: Mode = status.bootstrapped ? "login" : "register";
  if (mode === "register") return <RegisterPage />;
  return <LoginPage allowRegister={false} />;
}
