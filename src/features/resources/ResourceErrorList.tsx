type ResourceErrorListProps = {
  errors: string[];
  regionLabel: string;
};

export function ResourceErrorList({ errors, regionLabel }: ResourceErrorListProps) {
  if (errors.length === 0) return null;
  return (
    <div className="error-list">
      {errors.map((error, index) => (
        <div key={`${error}-${index}`}>{regionLabel}：{error}</div>
      ))}
    </div>
  );
}
