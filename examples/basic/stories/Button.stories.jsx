import { Button } from '../src/Button';

const row = { display: 'flex', gap: 12 };

export const Variants = () => (
  <div style={row}>
    <Button label="Save" />
    <Button label="Cancel" variant="secondary" />
  </div>
);

export const Disabled = () => <Button label="Save" disabled />;
