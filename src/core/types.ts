export type Confidence = "high" | "medium" | "low";
export type Availability = "ok" | "degraded" | "unavailable";
export type ActivityType = "sight" | "food" | "transport" | "stay" | "free";
export type BudgetCategory = "stay" | "transport" | "sight" | "food" | "other";

export interface Provenance {
  provider: string;
  source: string;
  fetchedAt: string;
  confidence: Confidence;
  url?: string;
  note?: string;
}

/** 所有数据工具的统一返回信封 */
export interface ToolEnvelope<T> {
  ok: boolean;
  availability: Availability;
  data: T | null;
  provenance: Provenance;
  error?: string;
}

export interface PlaceCandidate {
  id: string;
  name: string;
  category: string;
  city?: string;
  address?: string;
  lat: number;
  lon: number;
  openingHours?: string;
  ticketRange?: { min: number; max: number; currency: string };
  avgCost?: number;
  rating?: number;
  durationMin?: number;
  tips?: string;
  source: string;
  confidence: Confidence;
  verified: boolean;
}

export interface WeatherDay {
  date: string;
  weatherCode: number;
  weatherText: string;
  tempMax: number;
  tempMin: number;
  precipitationProb: number;
  windMax: number;
  sunrise?: string;
  sunset?: string;
}

export interface RouteResult {
  distanceMeters: number;
  durationMinutes: number;
  mode: "walking" | "driving" | "cycling";
  estimated: boolean;
  source: string;
  confidence: Confidence;
}

export interface CountryFacts {
  name: string;
  code: string;
  capital?: string;
  currencies: string[];
  languages: string[];
  timezones: string[];
  drivingSide?: string;
  region?: string;
  source: string;
  confidence: Confidence;
}

export interface ItineraryActivity {
  time: string;
  title: string;
  type: ActivityType;
  location: string;
  durationMin: number;
  costPerPerson: number;
  costTotal: number;
  costBasis?: "per_person" | "per_group";
  notes: string;
  source: string;
  fetchedAt: string;
  confidence: Confidence;
  needsBooking: boolean;
  bookingLeadDays?: number;
  verified: boolean;
}

export interface ItineraryDay {
  day: number;
  date: string;
  theme: string;
  totalCost: number;
  activities: ItineraryActivity[];
}

export interface BudgetLine {
  category: BudgetCategory;
  label: string;
  amount: number;
  unit: string;
  confidence: Confidence;
}

export interface ItineraryPlan {
  tripId: string;
  destination: string;
  startDate: string;
  endDate: string;
  travelers: { count: number; budgetTotal: number; currency: string };
  days: ItineraryDay[];
  budget: {
    lines: BudgetLine[];
    total: number;
    planned: number;
    delta: number;
  };
  risks: { level: "high" | "medium" | "low"; title: string; mitigation: string }[];
  unconfirmed: { item: string; reason: string; howToVerify: string }[];
}

export interface TripMeta {
  id: string;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  travelers: number;
  budgetTotal: number;
  currency: string;
  preferences: string[];
  status: "draft" | "approved";
  createdAt: string;
  updatedAt: string;
}
