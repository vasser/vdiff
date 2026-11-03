import './button.css';

export const Button = ({ label, variant = 'primary', disabled }) => (
  <button className={`btn btn-${variant}`} disabled={disabled}>
    {label}
  </button>
);
