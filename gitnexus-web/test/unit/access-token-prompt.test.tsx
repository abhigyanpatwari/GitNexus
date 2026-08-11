/**
 * The onboarding half of the edge token gate: a 401 has to read as "enter a
 * token", not "start a server", and the token the user enters has to reach
 * sessionStorage — and only sessionStorage.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTokenPrompt } from '../../src/components/AccessTokenPrompt';
import { i18nReady } from '../../src/i18n';
import { AUTH_TOKEN_STORAGE_KEY } from '../../src/config/ui-constants';
import { getAuthToken, setAuthToken } from '../../src/services/backend-client';

const TOKEN = 'deploy-token-abc123';

describe('AccessTokenPrompt', () => {
  beforeEach(async () => {
    await i18nReady;
    setAuthToken('');
  });

  afterEach(() => {
    setAuthToken('');
  });

  it('stores an entered token in sessionStorage, never localStorage', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AccessTokenPrompt onSubmit={onSubmit} />);

    const input = screen.getByLabelText('Access Token');
    // Masked by default — the token is never rendered in plain text unasked.
    expect(input).toHaveAttribute('type', 'password');

    await user.type(input, TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(getAuthToken()).toBe(TOKEN);
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('reveals and re-masks the token on request', async () => {
    const user = userEvent.setup();
    render(<AccessTokenPrompt />);

    await user.click(screen.getByRole('button', { name: 'Show access token' }));
    expect(screen.getByLabelText('Access Token')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide access token' }));
    expect(screen.getByLabelText('Access Token')).toHaveAttribute('type', 'password');
  });

  it('points at the Render environment variable that holds the token', () => {
    render(<AccessTokenPrompt />);
    expect(screen.getByText(/GITNEXUS_SERVE_AUTH_TOKEN/)).toBeInTheDocument();
  });
});
