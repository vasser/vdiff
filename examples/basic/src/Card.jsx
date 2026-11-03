export const Card = ({ title, children }) => (
  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, width: 280, fontFamily: 'sans-serif' }}>
    <h3 style={{ margin: '0 0 8px' }}>{title}</h3>
    <div>{children}</div>
  </div>
);
