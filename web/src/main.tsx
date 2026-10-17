import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api';
import { App } from './App';
import { AuthProvider } from './auth';
import './styles.css';
import './theme.css';
import { ToastProvider } from './ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000, refetchOnWindowFocus: true,
      // Retry only when the server could not be reached; never retry a 4xx answer.
      retry: (count, error) => !(error instanceof ApiError) && count < 2,
    },
    // Writes are never retried automatically: the user decides, and financial writes carry an idempotency key.
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
