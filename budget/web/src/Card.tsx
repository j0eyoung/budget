export function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card">
      <div className="muted">{label}</div>
      <div className="big">{value}</div>
      <div className="muted">{sub}</div>
    </div>
  )
}
