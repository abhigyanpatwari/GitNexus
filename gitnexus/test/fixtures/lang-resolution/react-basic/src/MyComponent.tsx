import React, { useCallback, useMemo, useEffect } from 'react';
import { Button } from './Button';

type CardProps = {
  title: string;
};

export const MyComponent = () => {
  const handleClick = useCallback(() => {
    console.log('clicked');
  }, []);

  const value = useMemo(() => 42, []);

  useEffect(() => {
    document.title = 'mounted';
  }, []);

  return (
    <div>
      <Button onClick={handleClick} label="click" />
      <OtherComp data={value} />
      <span>{value}</span>
    </div>
  );
};
