import { Suspense } from "react";

import { LoginForm } from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <main className="login-page">
      <div className="login-brand" aria-label="SailPoint">
        <svg className="brand-mark" viewBox="0 0 72 72" role="img">
          <path fill="#0032a1" d="M36 7 44.2 45H13.5L36 7Z" />
          <path fill="#d60db5" d="M36 7 60 45H44.2L36 7Z" />
          <path fill="#0071cd" d="M13.5 45h30.7l2.8 14L13.5 45Z" />
          <path fill="#e17fd2" d="M44.2 45H60L47 59l-2.8-14Z" />
        </svg>
        <span>SailPoint</span>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
