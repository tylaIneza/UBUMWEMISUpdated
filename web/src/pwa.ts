import { useEffect, useState } from 'react';

/** The browser's install prompt (Chrome, Edge, Android), kept until the user asks to install. */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Registers the service worker (production only) and keeps the install prompt for the "Install app" button. */
export function setUpPwa(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPrompt;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** `install` is set while the browser allows installing the app; calling it shows the browser's own dialog. */
export function useInstallApp(): { install: (() => Promise<void>) | null } {
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
  if (!deferred) return { install: null };
  return {
    install: async () => {
      const prompt = deferred!;
      await prompt.prompt();
      await prompt.userChoice;
      deferred = null;
      notify();
    },
  };
}
