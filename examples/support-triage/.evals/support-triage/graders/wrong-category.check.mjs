// Failure mode "wrong-category": the ticket is routed to the wrong queue.
// pass = the failure mode is absent.
export default function check({ output, expected }) {
  return {
    pass: output?.category === expected?.category,
    reason: `got ${output?.category}, expected ${expected?.category}`,
  }
}
