"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  loadDemoProgress,
  summarizeDemoProgress,
  type DemoProgressSummary,
} from "@/lib/demo/progress-storage";

export function HomeContinueDemo() {
  const [summary, setSummary] = useState<DemoProgressSummary | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSummary(summarizeDemoProgress(loadDemoProgress()));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!summary) {
    return null;
  }

  return (
    <Link
      href={summary.continueHref}
      className="home-continue"
    >
      <span className="home-continue__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M8 5v14l11-7L8 5Z" />
        </svg>
      </span>
      <span className="home-continue__content">
        <span className="home-continue__eyebrow">Pick up where you left off</span>
        <strong>{summary.label}</strong>
        <span>{summary.detail}</span>
      </span>
      <span className="home-continue__cta">
        Continue
        <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}
