import { useState } from 'react';
import { Eye, EyeOff } from '@/lib/lucide-icons';

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name for the field — the visible `<label>` is the caller's. */
  label: string;
  /** Accessible name for the toggle in each of its two states. */
  revealLabel: string;
  hideLabel: string;
}

/**
 * Masked text field with a reveal toggle, for secrets the user pastes in:
 * deploy access tokens, provider API keys. `type="password"` until the user
 * asks otherwise, and the value is never logged or put in a URL by anything
 * here.
 *
 * Reveal state lives inside the component, so a caller that unmounts the field
 * (the settings panel returns `null` when closed) reopens masked.
 */
export const SecretInput = ({
  value,
  onChange,
  placeholder,
  label,
  revealLabel,
  hideLabel,
}: SecretInputProps) => {
  const [isRevealed, setIsRevealed] = useState(false);

  return (
    <div className="relative">
      <input
        type={isRevealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 pr-11 font-mono text-sm text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="button"
        onClick={() => setIsRevealed((prev) => !prev)}
        aria-label={isRevealed ? hideLabel : revealLabel}
        className="absolute top-1/2 right-3 -translate-y-1/2 text-text-muted transition-colors hover:text-text-primary"
      >
        {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
};
