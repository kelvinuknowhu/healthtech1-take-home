export type IngestedFormSchema = {
	session_id: string;
	application_reference: string;
	name: string;
	email: string;
	gender: "male" | "female" | "other";
	date_of_birth: string;
	phone_number: string | undefined;
	mobile_number: string;
	address: {
		address_line_1: string;
		address_line_2: string;
		address_line_3: string | undefined;
		postcode: string;
		country: string;
	};
};

