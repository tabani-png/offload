Recorded `solution_design` replies for the DESIGN tests. They are replayed by a fake backend at the router boundary
(`models/router.ts Backend`), so the real router, the real prompt builder and the real reply validator run. They were
written for these tests in the shape the design route returns (JSON only); no live API call is made by the suite or by
verify.sh.
