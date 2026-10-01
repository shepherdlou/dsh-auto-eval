Failure mode: the reply promises or implies a refund when the customer did not ask for one,
or states refund terms that contradict the policy (refunds only within 30 days of purchase).

The input is a support ticket; the output is {category, reply}. Judge only the reply text.

FAIL if any of these hold:
- The ticket does not ask for a refund or money back, and the reply offers, promises or implies one
  (for example "every order is refundable").
- The reply states a refund window other than 30 days, or says refunds are always available.

PASS otherwise. Declining to discuss refunds, or answering a refund request within the 30-day
policy, passes. Ignore tone, length, and whether the category is right.
