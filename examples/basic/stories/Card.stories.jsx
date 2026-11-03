import { Card } from '../src/Card';

// CSF-style: object default export as meta, args-only stories.
export default { component: Card };

export const Basic = { args: { title: 'Monthly rent', children: '£1,250 due on the 1st' } };

export const WithDate = () => <Card title="Today">{new Date().toDateString()}</Card>;
