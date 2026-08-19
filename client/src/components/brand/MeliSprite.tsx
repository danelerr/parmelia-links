import bodyConveyor from "../../assets/meli/body-conveyor.webp";
import bodyCourier from "../../assets/meli/body-courier.webp";
import bodyPeekCard from "../../assets/meli/body-peek-card.webp";
import bodyQr from "../../assets/meli/body-qr.webp";
import bodySitting from "../../assets/meli/body-sitting.webp";
import bodySleeping from "../../assets/meli/body-sleeping.webp";
import headCautious from "../../assets/meli/head-cautious.webp";
import headCurious from "../../assets/meli/head-curious.webp";
import headExcited from "../../assets/meli/head-excited.webp";
import headFocused from "../../assets/meli/head-focused.webp";
import headHappy from "../../assets/meli/head-happy.webp";
import headNeutral from "../../assets/meli/head-neutral.webp";
import headPeek from "../../assets/meli/head-peek.webp";
import headSleepy from "../../assets/meli/head-sleepy.webp";

const sprites = {
	"body-conveyor": bodyConveyor,
	"body-courier": bodyCourier,
	"body-peek-card": bodyPeekCard,
	"body-qr": bodyQr,
	"body-sitting": bodySitting,
	"body-sleeping": bodySleeping,
	"head-cautious": headCautious,
	"head-curious": headCurious,
	"head-excited": headExcited,
	"head-focused": headFocused,
	"head-happy": headHappy,
	"head-neutral": headNeutral,
	"head-peek": headPeek,
	"head-sleepy": headSleepy,
} as const;

export type MeliSpriteName = keyof typeof sprites;
export type MeliMotion = "idle" | "purr" | "peek" | "deliver" | "none";

export default function MeliSprite({
	name,
	alt = "",
	className = "",
	motion = "none",
	priority = false,
}: {
	name: MeliSpriteName;
	alt?: string;
	className?: string;
	motion?: MeliMotion;
	priority?: boolean;
}) {
	return (
		<img
			src={sprites[name]}
			alt={alt}
			className={`meli-sprite meli-motion-${motion}${className ? ` ${className}` : ""}`}
			loading={priority ? "eager" : "lazy"}
			fetchPriority={priority ? "high" : "auto"}
			decoding="async"
			draggable={false}
		/>
	);
}
