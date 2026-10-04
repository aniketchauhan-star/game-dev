import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LucideProvider } from 'lucide-react';
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/space-grotesk/index.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/pages.css';
import './styles/studio2.css';
import { RouterProvider } from './lib/router.tsx';
import { JobsProvider } from './lib/jobs.tsx';
import { SaveStatusProvider } from './lib/saveStatus.tsx';
import { ToastProvider } from './components/ui/overlay.tsx';
import { App } from './App.tsx';
import { ApiError } from './lib/api.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LucideProvider className="ic">
        <RouterProvider>
          <ToastProvider>
            <SaveStatusProvider>
              <JobsProvider>
                <App />
              </JobsProvider>
            </SaveStatusProvider>
          </ToastProvider>
        </RouterProvider>
      </LucideProvider>
    </QueryClientProvider>
  </StrictMode>,
);
