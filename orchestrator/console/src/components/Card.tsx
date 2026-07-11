import type { ReactNode } from 'react';

type CardProps = {
  title: string;
  children: ReactNode;
};

const cardStyle = {
  border: '1px solid #ddd',
  borderRadius: '8px',
  padding: '12px 16px',
  marginBottom: '16px',
};

const titleStyle = {
  margin: '0 0 8px 0',
  fontSize: '1rem',
};

export function Card({ title, children }: CardProps) {
  return (
    <section style={cardStyle}>
      <h2 style={titleStyle}>{title}</h2>
      {children}
    </section>
  );
}
