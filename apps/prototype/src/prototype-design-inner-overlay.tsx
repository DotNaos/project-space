import type {
  LocalBox,
  MeasuredElement,
  PrototypeDesignAlignmentRegion,
} from "./prototype-design-analysis";
import { PrototypeDesignGapLabel } from "./prototype-design-gap-label";

export function PrototypeDesignInnerOverlay({
  alignmentRegions,
  box,
  detailed,
  inner,
  measurement,
}: {
  alignmentRegions: PrototypeDesignAlignmentRegion[];
  box: LocalBox;
  detailed: boolean;
  inner: MeasuredElement;
  measurement(value: number): string;
}) {
  return (
    <>
      <div
        className="prototype-design-tool__selection"
        data-candidate={detailed ? "detail" : "next-layer"}
        style={{
          height: inner.box.height,
          left: inner.box.left,
          top: inner.box.top,
          width: inner.box.width,
        }}
      />
      {detailed ? (
        <>
          {[inner.box.top, inner.box.bottom].map((top) => (
            <div className="prototype-design-tool__line-x" key={top} style={{ top }} />
          ))}
          {[inner.box.left, inner.box.right].map((left) => (
            <div className="prototype-design-tool__line-y" key={left} style={{ left }} />
          ))}
          {alignmentRegions.map((region) => (
            <div
              className="prototype-design-tool__alignment"
              data-kind={region.kind}
              data-orientation={region.orientation}
              data-testid="prototype-design-tool-alignment"
              key={region.key}
              style={{
                height: region.height,
                left: region.left,
                top: region.top,
                width: region.width,
              }}
            />
          ))}
          <PrototypeDesignGapLabel left={(box.left + inner.box.left) / 2} top={inner.box.top}>
            {measurement(Math.max(0, inner.box.left - box.left))}
          </PrototypeDesignGapLabel>
          <PrototypeDesignGapLabel left={(inner.box.right + box.right) / 2} top={inner.box.top}>
            {measurement(Math.max(0, box.right - inner.box.right))}
          </PrototypeDesignGapLabel>
          <PrototypeDesignGapLabel left={inner.box.left} top={(box.top + inner.box.top) / 2}>
            {measurement(Math.max(0, inner.box.top - box.top))}
          </PrototypeDesignGapLabel>
          <PrototypeDesignGapLabel left={inner.box.right} top={(inner.box.bottom + box.bottom) / 2}>
            {measurement(Math.max(0, box.bottom - inner.box.bottom))}
          </PrototypeDesignGapLabel>
        </>
      ) : null}
      <div
        className="prototype-design-tool__label prototype-design-tool__label--inner"
        style={{ left: inner.box.left, top: Math.max(4, inner.box.top - 22) }}
      >
        {detailed ? inner.label : `Next layer · ${inner.label} · L enters`} ·{" "}
        {measurement(inner.box.width)} × {measurement(inner.box.height)}
      </div>
    </>
  );
}
