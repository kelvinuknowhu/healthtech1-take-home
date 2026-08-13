import personOne from "../../src/forms/examples/person_one.json";
import personTwo from "../../src/forms/examples/person_two.json";
import personThree from "../../src/forms/examples/person_three.json";

export { personOne, personTwo, personThree };

type Payload = Record<string, unknown>;

/** Deep-clones a fixture so a test can mutate it without affecting others. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A valid form with a unique session_id, so tests don't collide. */
export const validForm = (overrides: Payload = {}): Payload => ({
	...clone(personOne as Payload),
	session_id: `test-${Math.random().toString(36).slice(2)}-${Date.now()}`,
	...overrides,
});

/** Successful geocode response, matching the provider's contract. */
export const geocodeOk = {
	statusCode: 200,
	body: { longitude: 50.05, latitude: -5.05 },
};

export const geocodeFail = { statusCode: 500, body: undefined };
export const emailOk = { statusCode: 200, body: undefined };
export const emailFail = { statusCode: 500, body: undefined };
