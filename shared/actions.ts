export type SelectPlan = {
  action: 'native' | 'click' | 'open' | 'error';
  value?: string;
  label?: string;
  x?: number;
  y?: number;
  error?: string;
};

export function readSelectPlan(value: unknown): SelectPlan {
  if (!value || typeof value !== 'object') throw new Error('select failed');
  const plan = value as SelectPlan;
  if (plan.action !== 'native' && plan.action !== 'click' && plan.action !== 'open' && plan.action !== 'error') {
    throw new Error('select failed');
  }
  return plan;
}

export function nativeSelectTrustedError(): Error {
  return new Error(
    'Trusted input required but not delivered. A native select is updated in the page; its option list is a browser popup, not a click. Synthetic input was not sent.',
  );
}
