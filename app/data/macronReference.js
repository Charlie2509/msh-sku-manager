const CATALOGUE_PENDING_SOURCE = "catalogue-pending";

const createPendingReference = ({ slug, displayName, garmentType = "unknown", aliases = [] }) => ({
  slug,
  displayName,
  garmentType,
  allowedColours: [],
  aliases,
  source: CATALOGUE_PENDING_SOURCE,
});

export const macronReferenceData = {
  elbrus: createPendingReference({ slug: "elbrus", displayName: "Elbrus", garmentType: "showerjacket" }),
  gyor: createPendingReference({ slug: "gyor", displayName: "Gyor" }),
  horn: createPendingReference({ slug: "horn", displayName: "Horn" }),
  northland: createPendingReference({ slug: "northland", displayName: "Northland" }),
  pepper: createPendingReference({ slug: "pepper", displayName: "Pepper" }),
  snow: createPendingReference({ slug: "snow", displayName: "Snow" }),
  turvey: createPendingReference({ slug: "turvey", displayName: "Turvey" }),
  rookie: createPendingReference({ slug: "rookie", displayName: "Rookie" }),
  barrier: createPendingReference({ slug: "barrier", displayName: "Barrier" }),
  anvik: createPendingReference({ slug: "anvik", displayName: "Anvik" }),
  round: createPendingReference({ slug: "round", displayName: "Round" }),
  aulos: createPendingReference({ slug: "aulos", displayName: "Aulos" }),
  coldmire: createPendingReference({ slug: "coldmire", displayName: "Coldmire" }),
  dance: createPendingReference({ slug: "dance", displayName: "Dance", garmentType: "hoodie" }),
};

export const macronModelReferences = Object.values(macronReferenceData);

export const macronReferenceMap = Object.fromEntries(
  Object.entries(macronReferenceData).map(([slug, reference]) => [slug.toLowerCase(), reference]),
);
