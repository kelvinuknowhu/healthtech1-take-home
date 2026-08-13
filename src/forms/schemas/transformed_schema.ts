export type TransformedFormSchema = {
	sessionId: string;
	applicationReference: string;
	firstName: string;
	lastName: string;
	email: string;
	gender: "male" | "female" | "prefer-not-to-say";
	dateOfBirth: Date;
	phoneNumber: string | undefined;
	mobileNumber: string;
	addressLine1: string;
	addressLine2: string;
	addressLine3: string | undefined;
	postcode: string;
	country: string;
	longitude: number;
	latitude: number;
};

