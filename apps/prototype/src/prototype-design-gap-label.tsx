export function PrototypeDesignGapLabel({
  children,
  left,
  top,
}: {
  children: string;
  left: number;
  top: number;
}) {
  return (
    <span
      className="absolute z-20 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-amber-300 px-1 py-0.5 text-[7px] font-semibold leading-none text-neutral-950"
      style={{ left, top }}
    >
      {children}
    </span>
  );
}
