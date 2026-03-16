import React, { useState } from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
}

export class Counter extends React.Component<{}, { count: number }> {
  state = { count: 0 };

  increment() {
    this.setState({ count: this.state.count + 1 });
  }

  render() {
    return <button onClick={() => this.increment()}>{this.state.count}</button>;
  }
}

export const Button: React.FC<ButtonProps> = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>;
};

export function useCounter(initial: number = 0) {
  const [count, setCount] = useState(initial);
  const increment = () => setCount(c => c + 1);
  const decrement = () => setCount(c => c - 1);
  return { count, increment, decrement };
}

const App = () => {
  const { count, increment } = useCounter();
  return (
    <div>
      <h1>Count: {count}</h1>
      <Button label="+" onClick={increment} />
    </div>
  );
};

export default App;
