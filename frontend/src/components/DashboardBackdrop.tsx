import AnimatedArtwork from "./AnimatedArtwork";
import { useEffect, useState } from "react";
import { LibraryBackdrop } from "../lib/libraryNavigation";
import { backdropOverlayGradients } from "../lib/dashboardSettings";

function BackdropLayers({
  urls,
  className,
  source,
}: {
  urls: string[];
  className: string;
  source: "mobile" | "desktop";
}) {
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.floor(Math.random() * urls.length),
  );

  useEffect(() => {
    setActiveIndex(Math.floor(Math.random() * urls.length));
    if (urls.length < 2) return;
    const interval = window.setInterval(() => {
      setActiveIndex((current) => {
        const offset = 1 + Math.floor(Math.random() * (urls.length - 1));
        return (current + offset) % urls.length;
      });
    }, 12000);
    return () => window.clearInterval(interval);
  }, [urls]);

  return (
    <div className={className} data-backdrop-source={source}>
      {urls.map((url, index) => (
        <AnimatedArtwork
          key={url}
          src={url}
          fill
          active={index === activeIndex}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-[2000ms] ease-in-out ${index === activeIndex ? "opacity-100" : "opacity-0"}`}
        />
      ))}
    </div>
  );
}

export default function DashboardBackdrop({
  desktopUrls,
  mobileUrls,
  overlayStrength,
}: {
  desktopUrls: string[];
  mobileUrls: string[];
  overlayStrength: number;
}) {
  const gradients = backdropOverlayGradients(overlayStrength);
  return (
    <LibraryBackdrop>
      <div
        className="pointer-events-none fixed inset-0 z-0"
        aria-hidden="true"
        data-testid="dashboard-backdrop"
      >
        {mobileUrls.length > 0 && (
          <BackdropLayers
            urls={mobileUrls}
            className="absolute inset-0 md:hidden"
            source="mobile"
          />
        )}
        {desktopUrls.length > 0 && (
          <BackdropLayers
            urls={desktopUrls}
            className="absolute inset-0 hidden md:block"
            source="desktop"
          />
        )}
        <div
          className="absolute inset-0 md:hidden"
          style={{ backgroundImage: gradients.mobile }}
        />
        <div
          className="absolute inset-0 hidden md:block"
          style={{ backgroundImage: gradients.desktop }}
        />
      </div>
    </LibraryBackdrop>
  );
}
