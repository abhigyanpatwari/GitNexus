import { ReactNode } from 'react';
import { Eye, EyeOff, Key } from '@/lib/lucide-icons';

type ApiKeyField = {
  value: string;
  placeholder: string;
  helperText?: string;
  helperLink?: string;
  helperLinkLabel?: string;
  isVisible: boolean;
  onChange: (value: string) => void;
  onToggleVisibility: () => void;
};

type ModelField = {
  value: string;
  placeholder: string;
  label?: string;
  helperText?: string;
  onChange: (value: string) => void;
};

interface ProviderConfigCardProps {
  title: string;
  description?: string;
  apiKey?: ApiKeyField;
  model?: ModelField;
  children?: ReactNode;
}

export const ProviderConfigCard = ({
  title,
  description,
  apiKey,
  model,
  children,
}: ProviderConfigCardProps) => {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {description ? (
            <p className="text-xs text-text-muted">{description}</p>
          ) : null}
        </div>
      </div>

      {apiKey && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
            <Key className="w-4 h-4" />
            API Key
          </label>
          <div className="relative">
            <input
              type={apiKey.isVisible ? 'text' : 'password'}
              value={apiKey.value}
              onChange={e => apiKey.onChange(e.target.value)}
              placeholder={apiKey.placeholder}
              className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
            />
            <button
              type="button"
              onClick={apiKey.onToggleVisibility}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
            >
              {apiKey.isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {apiKey.helperText && (
            <p className="text-xs text-text-muted">
              {apiKey.helperText}{' '}
              {apiKey.helperLink ? (
                <a
                  href={apiKey.helperLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {apiKey.helperLinkLabel ?? 'Learn more'}
                </a>
              ) : null}
            </p>
          )}
        </div>
      )}

      {model && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-text-secondary">
            {model.label ?? 'Model'}
          </label>
          <input
            type="text"
            value={model.value}
            onChange={e => model.onChange(e.target.value)}
            placeholder={model.placeholder}
            className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
          />
          {model.helperText ? (
            <p className="text-xs text-text-muted">{model.helperText}</p>
          ) : null}
        </div>
      )}

      {children}
    </div>
  );
};
