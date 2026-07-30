use crate::{
    application::data::page::DynamicEngineApplication,
    domain::{
        context::RequestContext,
        model::{HorizontalOrder, HorizontalQuery},
    },
    http::{
        dto::{HorizontalListRequest, HorizontalListResponse},
        error::ApiError,
        handler::HorizontalListUseCase,
    },
    ports::horizontal::{HorizontalListPort, HorizontalRefreshCoordinator},
};

impl<P> HorizontalListUseCase for DynamicEngineApplication<P>
where
    P: HorizontalListPort + HorizontalRefreshCoordinator + Send + Sync,
{
    fn list_horizontal(
        &self,
        context: &RequestContext,
        request: HorizontalListRequest,
    ) -> Result<HorizontalListResponse, ApiError> {
        // Java compatibility: the generic page component sends the horizontal
        // identity in usePageId when horizontalId is absent.
        let horizontal_id = request
            .horizontal_id
            .or(request.use_page_id)
            .ok_or_else(|| ApiError::validation("horizontalId or usePageId is required"))?;
        if request.operator.as_deref() == Some("REFRESH") {
            self.ports.refresh_horizontal(context, horizontal_id)?;
        }
        let page_no = request.page_no.unwrap_or(1);
        let page_size = request.page_size.unwrap_or(20);
        let query = HorizontalQuery {
            horizontal_id,
            selected_fields: request.select_values.keys().cloned().collect(),
            order: request
                .order_values
                .iter()
                .map(|order| HorizontalOrder {
                    field_name: order.field_name.clone(),
                    ascending: order.direction.eq_ignore_ascii_case("asc"),
                })
                .collect(),
            page_no,
            page_size,
            // EngineUseHorizontalInterReqVO does not declare showArchived.
            // The Java endpoint accepts the client's extra property but does
            // not apply it to the horizontal list query.
            show_archived: false,
        };
        let result = self.ports.list_horizontal(context, &query)?;
        Ok(HorizontalListResponse {
            req_id: if request.req_id.trim().is_empty() {
                context.request_id.clone()
            } else {
                request.req_id
            },
            page_no,
            page_size,
            total: result.total,
            resp_data: result.rows,
        })
    }
}
