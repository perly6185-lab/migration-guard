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
    ports::horizontal::HorizontalListPort,
};

impl<P> HorizontalListUseCase for DynamicEngineApplication<P>
where
    P: HorizontalListPort + Send + Sync,
{
    fn list_horizontal(
        &self,
        context: &RequestContext,
        request: HorizontalListRequest,
    ) -> Result<HorizontalListResponse, ApiError> {
        if request.operator.is_some() {
            return Err(ApiError::refresh(
                "horizontal refresh is a separate command and is not enabled",
                false,
            ));
        }
        let horizontal_id = request.horizontal_id.ok_or_else(|| {
            ApiError::validation("horizontalId is required until identity rewrite is approved")
        })?;
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
            show_archived: request.show_archived.unwrap_or(false),
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
