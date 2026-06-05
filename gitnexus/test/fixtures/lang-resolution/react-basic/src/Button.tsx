import React from 'react';

export const Button = (props: { onClick: () => void; label: string }) => {
  return <button onClick={props.onClick}>{props.label}</button>;
};
