import { fillTemplate } from '../prompts.js';
import type { PromptSpec } from './types.js';

const PLACEHOLDER_PATTERN = /{{([A-Z][A-Z0-9_]*)}}/g;

export function extractPromptVariables(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER_PATTERN), (match) => match[1]);
}

export function validatePromptSpec(spec: PromptSpec, label = 'prompt'): void {
  const allowed = new Set(spec.allowedVariables);
  const required = new Set(spec.requiredVariables);

  if (allowed.size !== spec.allowedVariables.length) {
    throw new Error(`${label}: allowedVariables contains duplicates`);
  }
  if (required.size !== spec.requiredVariables.length) {
    throw new Error(`${label}: requiredVariables contains duplicates`);
  }

  for (const variable of [...allowed, ...required]) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) {
      throw new Error(`${label}: invalid variable name ${JSON.stringify(variable)}`);
    }
  }
  for (const variable of required) {
    if (!allowed.has(variable)) {
      throw new Error(`${label}: required variable ${variable} is not allowed`);
    }
  }

  const referenced = new Set([
    ...extractPromptVariables(spec.system),
    ...extractPromptVariables(spec.user),
  ]);
  for (const variable of referenced) {
    if (!allowed.has(variable)) {
      throw new Error(`${label}: template references unknown variable ${variable}`);
    }
  }
  for (const variable of required) {
    if (!referenced.has(variable)) {
      throw new Error(`${label}: required variable ${variable} is not referenced`);
    }
  }
}

export function renderPrompt(
  spec: PromptSpec,
  variables: Record<string, string>,
): { system: string; user: string } {
  validatePromptSpec(spec);

  const allowed = new Set(spec.allowedVariables);
  for (const name of Object.keys(variables)) {
    if (!allowed.has(name)) {
      throw new Error(`Prompt variable ${name} is not allowed`);
    }
  }
  for (const name of spec.requiredVariables) {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Required prompt variable ${name} is missing`);
    }
  }

  const rendered = {
    system: fillTemplate(spec.system, variables),
    user: fillTemplate(spec.user, variables),
  };
  const residual = [
    ...extractPromptVariables(rendered.system),
    ...extractPromptVariables(rendered.user),
  ];
  if (residual.length > 0) {
    throw new Error(
      `Prompt contains unresolved variables: ${Array.from(new Set(residual)).join(', ')}`,
    );
  }
  return rendered;
}
