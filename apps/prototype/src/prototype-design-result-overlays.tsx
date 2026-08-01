import type {
  MeasuredElement,
  PrototypeDesignCollisionRegion,
} from "./prototype-design-analysis";

export function PrototypeDesignResultOverlays({
  collisions,
  formatMeasurement,
  passed,
}: {
  collisions: PrototypeDesignCollisionRegion[];
  formatMeasurement(value: number): string;
  passed: MeasuredElement[];
}) {
  return (
    <>
      {passed.map((element) => (
        <div
          className="prototype-design-tool__approved"
          data-testid="prototype-design-tool-approved"
          key={`${element.label}-${element.box.left}-${element.box.top}`}
          style={{
            height: element.box.height,
            left: element.box.left,
            top: element.box.top,
            width: element.box.width,
          }}
        >
          <span>Layer passed</span>
        </div>
      ))}
      {collisions.map((region) => (
        <div
          className="prototype-design-tool__collision"
          data-kind={region.kind}
          data-testid="prototype-design-tool-collision"
          key={region.key}
          style={{
            height: region.height,
            left: region.left,
            top: region.top,
            width: region.width,
          }}
        >
          <span>
            {region.kind === "edge-overhang"
              ? formatMeasurement(Number.parseFloat(region.label))
              : region.label}
          </span>
        </div>
      ))}
    </>
  );
}
